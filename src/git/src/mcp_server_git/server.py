import codecs
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional, Sequence
from mcp.server import Server
from mcp.server.session import ServerSession
from mcp.server.stdio import stdio_server
from mcp.types import (
    ClientCapabilities,
    TextContent,
    Tool,
    ListRootsResult,
    RootsCapability,
    ToolAnnotations,
)
from enum import Enum
import git
from git.exc import BadName
from pydantic import BaseModel, Field

# Default number of context lines to show in diff output
DEFAULT_CONTEXT_LINES = 3

# Upper bound, in UTF-8 bytes, on the git output a single tool call returns.
# Output beyond it is never read into memory; the git process is stopped and
# the result ends with TRUNCATION_NOTICE instead.
MAX_OUTPUT_BYTES = 48 * 1024
TRUNCATION_NOTICE = (
    "\n[output truncated: exceeded the {limit} byte limit; "
    "narrow the request (e.g. a smaller revision range or fewer files)]"
)
_STDERR_LIMIT = 4096


def _truncate_utf8(text: str, limit: int) -> tuple[str, bool]:
    encoded = text.encode("utf-8")
    if len(encoded) <= limit:
        return text, False
    return encoded[:limit].decode("utf-8", errors="ignore"), True


def _with_notice(text: str, truncated: bool) -> str:
    if not truncated:
        return text
    return text + TRUNCATION_NOTICE.format(limit=MAX_OUTPUT_BYTES)


def _run_git_bounded(repo: git.Repo, args: list[str], limit: int = MAX_OUTPUT_BYTES) -> tuple[str, bool]:
    """Run git and return at most `limit` UTF-8 bytes of its stdout.

    Reads no more than `limit + 1` bytes; if git has more to write, it is
    killed rather than drained. Returns the decoded text and whether it was
    truncated.
    """
    limit = max(limit, 0)
    command = [git.Git.GIT_PYTHON_GIT_EXECUTABLE or "git", *args]
    with tempfile.TemporaryFile() as stderr:
        proc = subprocess.Popen(
            command,
            cwd=repo.working_dir,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=stderr,
        )
        assert proc.stdout is not None
        try:
            data = proc.stdout.read(limit + 1)
            overflow = len(data) > limit
            if overflow:
                proc.kill()
        finally:
            proc.stdout.close()
            status = proc.wait()
        if not overflow and status != 0:
            stderr.seek(0)
            message = stderr.read(_STDERR_LIMIT).decode("utf-8", errors="replace")
            raise git.GitCommandError(command, status, message)

    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    text, truncated = _truncate_utf8(decoder.decode(data[:limit], final=not overflow), limit)
    truncated = truncated or overflow
    if not truncated and text.endswith("\n"):
        text = text[:-1]
    return text, truncated


def _resolve_revision(repo: git.Repo, revision: str, peel: str = "object") -> str:
    """Resolve `revision` to an object id with git rev-parse.

    GitPython's rev_parse parses every commit it walks for `~`/`^` navigation,
    reading each object (and its message) fully into this process.
    """
    try:
        sha, truncated = _run_git_bounded(
            repo, ["rev-parse", "--verify", "--quiet", f"{revision}^{{{peel}}}"], 128
        )
    except git.GitCommandError:
        raise BadName(revision)
    if truncated or not sha:
        raise BadName(revision)
    return sha


class GitStatus(BaseModel):
    repo_path: str

class GitDiffUnstaged(BaseModel):
    repo_path: str
    context_lines: int = DEFAULT_CONTEXT_LINES

class GitDiffStaged(BaseModel):
    repo_path: str
    context_lines: int = DEFAULT_CONTEXT_LINES

class GitDiff(BaseModel):
    repo_path: str
    target: str
    context_lines: int = DEFAULT_CONTEXT_LINES

class GitCommit(BaseModel):
    repo_path: str
    message: str

class GitAdd(BaseModel):
    repo_path: str
    files: list[str]

class GitReset(BaseModel):
    repo_path: str

class GitLog(BaseModel):
    repo_path: str
    max_count: int = 10
    start_timestamp: Optional[str] = Field(
        None,
        description="Start timestamp for filtering commits. Accepts: ISO 8601 format (e.g., '2024-01-15T14:30:25'), relative dates (e.g., '2 weeks ago', 'yesterday'), or absolute dates (e.g., '2024-01-15', 'Jan 15 2024')"
    )
    end_timestamp: Optional[str] = Field(
        None,
        description="End timestamp for filtering commits. Accepts: ISO 8601 format (e.g., '2024-01-15T14:30:25'), relative dates (e.g., '2 weeks ago', 'yesterday'), or absolute dates (e.g., '2024-01-15', 'Jan 15 2024')"
    )

class GitCreateBranch(BaseModel):
    repo_path: str
    branch_name: str
    base_branch: str | None = None

class GitCheckout(BaseModel):
    repo_path: str
    branch_name: str

class GitShow(BaseModel):
    repo_path: str
    revision: str



class GitBranch(BaseModel):
    repo_path: str = Field(
        ...,
        description="The path to the Git repository.",
    )
    branch_type: str = Field(
        ...,
        description="Whether to list local branches ('local'), remote branches ('remote') or all branches('all').",
    )
    contains: Optional[str] = Field(
        None,
        description="The commit sha that branch should contain. Do not pass anything to this param if no commit sha is specified",
    )
    not_contains: Optional[str] = Field(
        None,
        description="The commit sha that branch should NOT contain. Do not pass anything to this param if no commit sha is specified",
    )


class GitTools(str, Enum):
    STATUS = "git_status"
    DIFF_UNSTAGED = "git_diff_unstaged"
    DIFF_STAGED = "git_diff_staged"
    DIFF = "git_diff"
    COMMIT = "git_commit"
    ADD = "git_add"
    RESET = "git_reset"
    LOG = "git_log"
    CREATE_BRANCH = "git_create_branch"
    CHECKOUT = "git_checkout"
    SHOW = "git_show"

    BRANCH = "git_branch"

def git_status(repo: git.Repo) -> str:
    return _with_notice(*_run_git_bounded(repo, ["status"]))

def git_diff_unstaged(repo: git.Repo, context_lines: int = DEFAULT_CONTEXT_LINES) -> str:
    return _with_notice(*_run_git_bounded(repo, ["diff", f"--unified={context_lines}"]))

def git_diff_staged(repo: git.Repo, context_lines: int = DEFAULT_CONTEXT_LINES) -> str:
    return _with_notice(*_run_git_bounded(repo, ["diff", f"--unified={context_lines}", "--cached"]))

def git_diff(repo: git.Repo, target: str, context_lines: int = DEFAULT_CONTEXT_LINES) -> str:
    # Defense in depth: reject targets starting with '-' to prevent flag injection,
    # even if a malicious ref with that name exists (e.g. via filesystem manipulation)
    if target.startswith("-"):
        raise BadName(f"Invalid target: '{target}' - cannot start with '-'")
    sha = _resolve_revision(repo, target)  # Validates target is a real git ref, throws BadName if not
    return _with_notice(*_run_git_bounded(repo, ["diff", f"--unified={context_lines}", sha]))

def git_commit(repo: git.Repo, message: str) -> str:
    commit = repo.index.commit(message)
    return f"Changes committed successfully with hash {commit.hexsha}"

def git_add(repo: git.Repo, files: list[str]) -> str:
    if files == ["."]:
        repo.git.add(".")
    else:
        # Defense in depth: validate each path resolves within the repository
        # working tree to prevent path traversal (e.g. '../../etc/passwd' or an
        # absolute path) from staging files outside repository boundaries.
        repo_root = Path(repo.working_dir).resolve()
        for f in files:
            try:
                resolved = (repo_root / f).resolve()
            except (OSError, RuntimeError):
                raise ValueError(f"Invalid path: '{f}'")
            try:
                resolved.relative_to(repo_root)
            except ValueError:
                raise ValueError(
                    f"Path '{f}' is outside the repository '{repo_root}'"
                )
        # Use '--' to prevent files starting with '-' from being interpreted as options
        repo.git.add("--", *files)
    return "Files staged successfully"

def git_reset(repo: git.Repo) -> str:
    repo.index.reset()
    return "All staged changes reset"

def git_log(repo: git.Repo, max_count: int = 10, start_timestamp: Optional[str] = None, end_timestamp: Optional[str] = None) -> list[str]:
    # Defense in depth: reject timestamps starting with '-' to prevent flag injection
    if start_timestamp and start_timestamp.startswith("-"):
        raise ValueError(f"Invalid start_timestamp: '{start_timestamp}' - cannot start with '-'")
    if end_timestamp and end_timestamp.startswith("-"):
        raise ValueError(f"Invalid end_timestamp: '{end_timestamp}' - cannot start with '-'")

    kwargs: dict[str, Any] = {"max_count": max_count}
    if start_timestamp:
        kwargs["since"] = start_timestamp
    if end_timestamp:
        kwargs["until"] = end_timestamp

    log: list[str] = []
    remaining = MAX_OUTPUT_BYTES
    for commit in repo.iter_commits(**kwargs):
        # commit.size reads only the object header, so an oversized commit is
        # never parsed into memory.
        if commit.size > remaining:
            log.append(TRUNCATION_NOTICE.format(limit=MAX_OUTPUT_BYTES).lstrip("\n"))
            break
        entry, truncated = _truncate_utf8(
            f"Commit: {commit.hexsha}\n"
            f"Author: {commit.author}\n"
            f"Date: {commit.authored_datetime}\n"
            f"Message: {commit.message}\n",
            remaining,
        )
        log.append(entry)
        remaining -= len(entry.encode("utf-8")) + 1
        if truncated or remaining <= 0:
            log.append(TRUNCATION_NOTICE.format(limit=MAX_OUTPUT_BYTES).lstrip("\n"))
            break
    return log

def git_create_branch(repo: git.Repo, branch_name: str, base_branch: str | None = None) -> str:
    # Defense in depth: reject names starting with '-' to prevent flag injection
    if branch_name.startswith("-"):
        raise BadName(f"Invalid branch name: '{branch_name}' - cannot start with '-'")
    if base_branch and base_branch.startswith("-"):
        raise BadName(f"Invalid base branch: '{base_branch}' - cannot start with '-'")
    if base_branch:
        base = repo.references[base_branch]
    else:
        base = repo.active_branch

    repo.create_head(branch_name, base)
    return f"Created branch '{branch_name}' from '{base.name}'"

def git_checkout(repo: git.Repo, branch_name: str) -> str:
    # Defense in depth: reject branch names starting with '-' to prevent flag injection,
    # even if a malicious ref with that name exists (e.g. via filesystem manipulation)
    if branch_name.startswith("-"):
        raise BadName(f"Invalid branch name: '{branch_name}' - cannot start with '-'")
    _resolve_revision(repo, branch_name)  # Validates branch_name is a real git ref, throws BadName if not
    repo.git.checkout(branch_name)
    return f"Switched to branch '{branch_name}'"



def git_show(repo: git.Repo, revision: str) -> str:
    # Defense in depth: reject revisions starting with '-' to prevent flag injection,
    # even if a malicious ref with that name exists (e.g. via filesystem manipulation)
    if revision.startswith("-"):
        raise BadName(f"Invalid revision: '{revision}' - cannot start with '-'")
    commit = repo.commit(_resolve_revision(repo, revision, "commit"))
    # commit.size reads only the object header, so an oversized commit object
    # is never parsed into memory.
    if commit.size > MAX_OUTPUT_BYTES:
        return _with_notice(f"Commit: {commit.hexsha!r}\n", True)
    header, truncated = _truncate_utf8(
        f"Commit: {commit.hexsha!r}\n"
        f"Author: {commit.author!r}\n"
        f"Date: {commit.authored_datetime!r}\n"
        f"Message: {commit.message!r}\n",
        MAX_OUTPUT_BYTES,
    )
    if truncated:
        return _with_notice(header, True)

    if commit.parents:
        diff_args = [commit.parents[0].hexsha, commit.hexsha]
    else:
        diff_args = ["--root", commit.hexsha]
    patch, truncated = _run_git_bounded(
        repo,
        ["diff-tree", "-r", "-p", "--no-commit-id", *diff_args],
        MAX_OUTPUT_BYTES - len(header.encode("utf-8")) - 1,
    )
    if patch:
        header += "\n" + patch
    return _with_notice(header, truncated)

def validate_repo_path(repo_path: Path, allowed_repository: Path | None) -> None:
    """Validate that repo_path is within the allowed repository path."""
    if allowed_repository is None:
        return  # No restriction configured

    # Resolve both paths to handle symlinks and relative paths
    try:
        resolved_repo = repo_path.resolve()
        resolved_allowed = allowed_repository.resolve()
    except (OSError, RuntimeError):
        raise ValueError(f"Invalid path: {repo_path}")

    # Check if repo_path is the same as or a subdirectory of allowed_repository
    try:
        resolved_repo.relative_to(resolved_allowed)
    except ValueError:
        raise ValueError(
            f"Repository path '{repo_path}' is outside the allowed repository '{allowed_repository}'"
        )


def git_branch(repo: git.Repo, branch_type: str, contains: str | None = None, not_contains: str | None = None) -> str:
    # Defense in depth: reject values starting with '-' to prevent flag injection
    if contains and contains.startswith("-"):
        raise BadName(f"Invalid contains value: '{contains}' - cannot start with '-'")
    if not_contains and not_contains.startswith("-"):
        raise BadName(f"Invalid not_contains value: '{not_contains}' - cannot start with '-'")

    match contains:
        case None:
            contains_sha = (None,)
        case _:
            contains_sha = ("--contains", contains)

    match not_contains:
        case None:
            not_contains_sha = (None,)
        case _:
            not_contains_sha = ("--no-contains", not_contains)

    match branch_type:
        case 'local':
            b_type = None
        case 'remote':
            b_type = "-r"
        case 'all':
            b_type = "-a"
        case _:
            return f"Invalid branch type: {branch_type}"

    args = [arg for arg in ("branch", b_type, *contains_sha, *not_contains_sha) if arg is not None]
    return _with_notice(*_run_git_bounded(repo, args))


async def serve(repository: Path | None) -> None:
    logger = logging.getLogger(__name__)

    if repository is not None:
        try:
            git.Repo(repository)
            logger.info(f"Using repository at {repository}")
        except git.InvalidGitRepositoryError:
            logger.error(f"{repository} is not a valid Git repository")
            return

    server = Server("mcp-git")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name=GitTools.STATUS,
                description="Shows the working tree status",
                inputSchema=GitStatus.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.DIFF_UNSTAGED,
                description="Shows changes in the working directory that are not yet staged",
                inputSchema=GitDiffUnstaged.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.DIFF_STAGED,
                description="Shows changes that are staged for commit",
                inputSchema=GitDiffStaged.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.DIFF,
                description="Shows differences between branches or commits",
                inputSchema=GitDiff.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.COMMIT,
                description="Records changes to the repository",
                inputSchema=GitCommit.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=False,
                    destructiveHint=False,
                    idempotentHint=False,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.ADD,
                description="Adds file contents to the staging area",
                inputSchema=GitAdd.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=False,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.RESET,
                description="Unstages all staged changes",
                inputSchema=GitReset.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=False,
                    destructiveHint=True,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.LOG,
                description="Shows the commit logs",
                inputSchema=GitLog.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.CREATE_BRANCH,
                description="Creates a new branch from an optional base branch",
                inputSchema=GitCreateBranch.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=False,
                    destructiveHint=False,
                    idempotentHint=False,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.CHECKOUT,
                description="Switches branches",
                inputSchema=GitCheckout.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=False,
                    destructiveHint=False,
                    idempotentHint=False,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.SHOW,
                description="Shows the contents of a commit",
                inputSchema=GitShow.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            ),
            Tool(
                name=GitTools.BRANCH,
                description="List Git branches",
                inputSchema=GitBranch.model_json_schema(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            )
        ]

    async def list_repos() -> Sequence[str]:
        async def by_roots() -> Sequence[str]:
            if not isinstance(server.request_context.session, ServerSession):
                raise TypeError("server.request_context.session must be a ServerSession")

            if not server.request_context.session.check_client_capability(
                ClientCapabilities(roots=RootsCapability())
            ):
                return []

            roots_result: ListRootsResult = await server.request_context.session.list_roots()
            logger.debug(f"Roots result: {roots_result}")
            repo_paths = []
            for root in roots_result.roots:
                path = root.uri.path
                try:
                    git.Repo(path)
                    repo_paths.append(str(path))
                except git.InvalidGitRepositoryError:
                    pass
            return repo_paths

        def by_commandline() -> Sequence[str]:
            return [str(repository)] if repository is not None else []

        cmd_repos = by_commandline()
        root_repos = await by_roots()
        return [*root_repos, *cmd_repos]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        repo_path = Path(arguments["repo_path"])

        # Validate repo_path is within allowed repository
        validate_repo_path(repo_path, repository)

        # For all commands, we need an existing repo
        repo = git.Repo(repo_path)

        match name:
            case GitTools.STATUS:
                status = git_status(repo)
                return [TextContent(
                    type="text",
                    text=f"Repository status:\n{status}"
                )]

            case GitTools.DIFF_UNSTAGED:
                diff = git_diff_unstaged(repo, arguments.get("context_lines", DEFAULT_CONTEXT_LINES))
                return [TextContent(
                    type="text",
                    text=f"Unstaged changes:\n{diff}"
                )]

            case GitTools.DIFF_STAGED:
                diff = git_diff_staged(repo, arguments.get("context_lines", DEFAULT_CONTEXT_LINES))
                return [TextContent(
                    type="text",
                    text=f"Staged changes:\n{diff}"
                )]

            case GitTools.DIFF:
                diff = git_diff(repo, arguments["target"], arguments.get("context_lines", DEFAULT_CONTEXT_LINES))
                return [TextContent(
                    type="text",
                    text=f"Diff with {arguments['target']}:\n{diff}"
                )]

            case GitTools.COMMIT:
                result = git_commit(repo, arguments["message"])
                return [TextContent(
                    type="text",
                    text=result
                )]

            case GitTools.ADD:
                result = git_add(repo, arguments["files"])
                return [TextContent(
                    type="text",
                    text=result
                )]

            case GitTools.RESET:
                result = git_reset(repo)
                return [TextContent(
                    type="text",
                    text=result
                )]

            # Update the LOG case:
            case GitTools.LOG:
                log = git_log(
                    repo,
                    arguments.get("max_count", 10),
                    arguments.get("start_timestamp"),
                    arguments.get("end_timestamp")
                )
                return [TextContent(
                    type="text",
                    text="Commit history:\n" + "\n".join(log)
                )]

            case GitTools.CREATE_BRANCH:
                result = git_create_branch(
                    repo,
                    arguments["branch_name"],
                    arguments.get("base_branch")
                )
                return [TextContent(
                    type="text",
                    text=result
                )]

            case GitTools.CHECKOUT:
                result = git_checkout(repo, arguments["branch_name"])
                return [TextContent(
                    type="text",
                    text=result
                )]

            case GitTools.SHOW:
                result = git_show(repo, arguments["revision"])
                return [TextContent(
                    type="text",
                    text=result
                )]

            case GitTools.BRANCH:
                result = git_branch(
                    repo,
                    arguments.get("branch_type", 'local'),
                    arguments.get("contains", None),
                    arguments.get("not_contains", None),
                )
                return [TextContent(
                    type="text",
                    text=result
                )]

            case _:
                raise ValueError(f"Unknown tool: {name}")

    options = server.create_initialization_options()
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, options)
