import simpleGit, { SimpleGit } from "simple-git"
import { getLfsPatterns, writeExcludesFile } from "./CheckpointExclusions"
import fs from "fs/promises"
import * as path from "path"
import { fileExistsAtPath } from "../../utils/fs"
import * as vscode from "vscode"
import { getWorkingDirectory, hashWorkingDir } from "./CheckpointUtils"
import { HistoryItem } from "../../shared/HistoryItem"

interface StorageProvider {
	context: {
		globalStorageUri: { fsPath: string }
	}
}

interface CheckpointAddResult {
	success: boolean
	fileCount: number
}

/**
 * GitOperations Class
 *
 * Handles git-specific operations for Cline's Checkpoints system.
 *
 * Key responsibilities:
 * - Git repository initialization and configuration
 * - Git settings management (user, LFS, etc.)
 * - Worktree configuration and management
 * - Task-specific branch management (creation, switching, deletion)
 * - Handling of both legacy and branch-per-task checkpoint structures
 * - Managing nested git repositories during checkpoint operations
 * - File staging and checkpoint creation
 * - Shadow git repository maintenance and cleanup
 */
export class GitOperations {
	private cwd: string
	private isLegacyCheckpoint: boolean

	/**
	 * Creates a new GitOperations instance.
	 *
	 * @param cwd - The current working directory for git operations
	 * @param isLegacyCheckpoint - Whether this is operating in legacy checkpoint mode
	 */
	constructor(cwd: string, isLegacyCheckpoint: boolean) {
		this.cwd = cwd
		this.isLegacyCheckpoint = isLegacyCheckpoint
	}

	/**
	 * Initializes or verifies a shadow Git repository for checkpoint tracking.
	 * Creates a new repository if one doesn't exist, or verifies the worktree
	 * configuration if it does.
	 *
	 * Key operations:
	 * - Creates/verifies shadow git repository
	 * - Configures git settings (user, LFS, etc.)
	 * - Sets up worktree to point to workspace
	 * - Creates initial empty commit
	 * - Handles both legacy and branch-per-task checkpoint structures
	 *
	 * @param gitPath - Path to the .git directory
	 * @param cwd - The current working directory for git operations
	 * @param isLegacyCheckpoint - Whether this is operating in legacy checkpoint mode
	 * @returns Promise<string> Path to the initialized .git directory
	 * @throws Error if:
	 * - Worktree verification fails for existing repository
	 * - Git initialization or configuration fails
	 * - Unable to create initial commit
	 * - LFS pattern setup fails
	 */
	public static async initShadowGit(gitPath: string, cwd: string, isLegacyCheckpoint: boolean): Promise<string> {
		console.info(`Initializing ${isLegacyCheckpoint ? "legacy" : "branch-per-task"} shadow git`)

		// If repo exists, just verify worktree
		if (await fileExistsAtPath(gitPath)) {
			const git = simpleGit(path.dirname(gitPath))
			const worktree = await git.getConfig("core.worktree")
			if (worktree.value !== cwd) {
				throw new Error("Checkpoints can only be used in the original workspace: " + worktree.value)
			}
			console.warn(`Using existing ${isLegacyCheckpoint ? "legacy" : "branch-per-task"} shadow git at ${gitPath}`)
			return gitPath
		}

		// Initialize new repo
		const checkpointsDir = path.dirname(gitPath)
		console.warn(`Creating new ${isLegacyCheckpoint ? "legacy" : "branch-per-task"} shadow git in ${checkpointsDir}`)

		const git = simpleGit(checkpointsDir)
		await git.init()

		// Configure repo
		await git.addConfig("core.worktree", cwd)
		await git.addConfig("commit.gpgSign", "false")
		await git.addConfig("user.name", "Cline Checkpoint")
		await git.addConfig("user.email", "checkpoint@cline.bot")
		await git.addConfig("core.quotePath", "false")
		await git.addConfig("core.precomposeunicode", "true")

		// Set up LFS patterns
		const lfsPatterns = await getLfsPatterns(cwd)
		await writeExcludesFile(gitPath, lfsPatterns)

		// Initial commit only on first repo creation
		await git.commit("initial commit", { "--allow-empty": null })

		console.warn(`${isLegacyCheckpoint ? "Legacy" : "New"} shadow git initialization completed`)

		return gitPath
	}

	/**
	 * Retrieves the worktree path from the shadow git configuration.
	 * The worktree path indicates where the shadow git repository is tracking files,
	 * which should match the current workspace directory.
	 *
	 * @param gitPath - Path to the .git directory
	 * @returns Promise<string | undefined> The worktree path or undefined if not found
	 * @throws Error if unable to get worktree path
	 */
	public async getShadowGitConfigWorkTree(gitPath: string): Promise<string | undefined> {
		try {
			const git = simpleGit(path.dirname(gitPath))
			const worktree = await git.getConfig("core.worktree")
			return worktree.value || undefined
		} catch (error) {
			console.error("Failed to get shadow git config worktree:", error)
			return undefined
		}
	}

	/**
	 * Checks if a shadow Git repository exists for the given task and workspace.
	 * Checks both legacy checkpoint paths (tasks/{taskId}/checkpoints/.git) and
	 * branch-per-task paths (checkpoints/{workspaceHash}/.git).
	 *
	 * @param taskId - The ID of the task whose shadow git to check
	 * @param provider - The ClineProvider instance for accessing VS Code functionality
	 * @returns Promise<boolean> True if either a legacy or branch-per-task shadow git exists, false otherwise
	 */
	public static async doesShadowGitExist(taskId: string, provider?: StorageProvider): Promise<boolean> {
		const globalStoragePath = provider?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			return false
		}

		// Check legacy checkpoint path to see if this is a legacy task
		const legacyGitPath = path.join(globalStoragePath, "tasks", taskId, "checkpoints", ".git")
		if (await fileExistsAtPath(legacyGitPath)) {
			console.info("Found legacy shadow git")
			return true
		}

		// Check branch-per-task path for newer tasks
		const workingDir = await getWorkingDirectory()
		const cwdHash = hashWorkingDir(workingDir)
		const gitPath = path.join(globalStoragePath, "checkpoints", cwdHash, ".git")
		const exists = await fileExistsAtPath(gitPath)
		if (exists) {
			console.info("Found branch-per-task shadow git")
		}
		return exists
	}

	/**
	 * Deletes a branch in the git repository, handling cases where the branch is currently checked out.
	 * If the branch to be deleted is currently checked out, the method will:
	 * 1. Save the current worktree configuration
	 * 2. Temporarily unset the worktree to prevent workspace modifications
	 * 3. Force switch to master/main branch
	 * 4. Delete the target branch
	 * 5. Restore the worktree configuration
	 *
	 * @param git - SimpleGit instance to use for operations
	 * @param branchName - Name of the branch to delete
	 * @param checkpointsDir - Directory containing the git repository
	 * @throws Error if:
	 *  - Branch deletion fails
	 *  - Unable to switch to master/main branch after 3 retries
	 *  - Git operations fail during the process
	 */
	public static async deleteBranchForGit(git: SimpleGit, branchName: string, checkpointsDir: string): Promise<void> {
		// Check if branch exists
		const branches = await git.branchLocal()
		if (!branches.all.includes(branchName)) {
			console.error(`Task branch ${branchName} does not exist, nothing to delete`)
			return // Branch doesn't exist, nothing to delete
		}

		// First, if we're on the branch to be deleted, switch to master/main
		const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"])
		console.info(`Current branch: ${currentBranch}, target branch to delete: ${branchName}`)

		if (currentBranch === branchName) {
			console.debug("Currently on branch to be deleted, switching to master/main first")
			// Save the current worktree config
			const worktree = await git.getConfig("core.worktree")
			console.debug(`Saved current worktree config: ${worktree.value}`)

			try {
				// Temporarily unset worktree to prevent workspace modifications
				console.debug("Temporarily unsetting worktree config")
				await git.raw(["config", "--unset", "core.worktree"])

				// Force discard all changes
				console.debug("Discarding all changes")
				await git.reset(["--hard"])
				await git.clean("f", ["-d"]) // Clean mode 'f' for force, -d for directories

				// Determine default branch (master or main)
				const defaultBranch = branches.all.includes("main") ? "main" : "master"
				console.debug(`Using ${defaultBranch} as default branch`)

				// Switch to default branch and delete branch
				console.debug(`Attempting to force switch to ${defaultBranch} branch`)
				await git.checkout([defaultBranch, "--force"])

				// Verify the switch completed
				let retries = 3
				while (retries > 0) {
					const newBranch = await git.revparse(["--abbrev-ref", "HEAD"])
					console.debug(`Verifying branch switch - current branch: ${newBranch}, attempts left: ${retries}`)
					if (newBranch === defaultBranch) {
						console.debug(`Successfully switched to ${defaultBranch} branch`)
						break
					}
					retries--
					if (retries === 0) {
						throw new Error(`Failed to switch to ${defaultBranch} branch`)
					}
				}

				console.info(`Deleting branch: ${branchName}`)
				await git.raw(["branch", "-D", branchName])
				console.debug(`Successfully deleted branch: ${branchName}`)
			} finally {
				// Restore the worktree config
				if (worktree.value) {
					console.debug(`Restoring worktree config to: ${worktree.value}`)
					await git.addConfig("core.worktree", worktree.value)
				}
			}
		} else {
			// If we're not on the branch, we can safely delete it
			console.info(`Directly deleting branch ${branchName} since we're not on it`)
			await git.raw(["branch", "-D", branchName])
			console.debug(`Successfully deleted branch: ${branchName}`)
		}
	}

	/**
	 * Static method to delete a task's branch using stored workspace path.
	 * Handles both branch-per-task and legacy checkpoint formats:
	 * 1. First attempts to delete branch-per-task checkpoint if it exists
	 * 2. Falls back to deleting legacy checkpoint directory if found
	 *
	 * @param taskId - The ID of the task whose branch should be deleted
	 * @param historyItem - The history item containing the shadow git config
	 * @param globalStoragePath - Path to VS Code's global storage
	 * @throws Error if:
	 *  - Global storage path is invalid
	 *  - Branch deletion fails
	 *  - Legacy checkpoint directory deletion fails
	 */
	public static async deleteTaskBranchStatic(
		taskId: string,
		historyItem: HistoryItem,
		globalStoragePath: string,
	): Promise<void> {
		try {
			console.debug("Starting static task branch deletion process...")

			if (!globalStoragePath) {
				throw new Error("Global storage uri is invalid")
			}

			// First try to handle branch-per-task checkpoint
			let workingDir: string
			if (historyItem.shadowGitConfigWorkTree) {
				workingDir = historyItem.shadowGitConfigWorkTree
			} else {
				// Try to determine working directory from current state
				workingDir = await getWorkingDirectory()
			}

			const cwdHash = hashWorkingDir(workingDir)
			const checkpointsDir = path.join(globalStoragePath, "checkpoints", cwdHash)
			const gitPath = path.join(checkpointsDir, ".git")

			if (await fileExistsAtPath(gitPath)) {
				console.debug(`Found branch-per-task git repository at ${gitPath}`)
				const git = simpleGit(path.dirname(gitPath))
				const branchName = `task-${taskId}`

				// Check if the branch exists
				const branches = await git.branchLocal()
				if (branches.all.includes(branchName)) {
					console.info(`Found branch ${branchName} to delete`)
					await GitOperations.deleteBranchForGit(git, branchName, checkpointsDir)
					return
				}
				console.warn(`Branch ${branchName} not found in branch-per-task repository`)
			}

			// Only check legacy checkpoint if we didn't find/delete a branch-per-task branch
			const legacyCheckpointsDir = path.join(globalStoragePath, "tasks", taskId, "checkpoints")
			const legacyGitPath = path.join(legacyCheckpointsDir, ".git")

			if (await fileExistsAtPath(legacyGitPath)) {
				console.info("Found legacy checkpoint, deleting directory")
				try {
					await fs.rm(legacyCheckpointsDir, { recursive: true, force: true })
					console.debug("Successfully deleted legacy checkpoint directory")
					return
				} catch (error) {
					console.error("Failed to delete legacy checkpoint directory:", error)
					throw error
				}
			}

			console.info("No checkpoints found to delete")
		} catch (error) {
			console.error("Failed to delete task branch:", error)
			throw new Error(`Failed to delete task branch: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * Since we use git to track checkpoints, we need to temporarily disable nested git repos to work around git's
	 * requirement of using submodules for nested repos.
	 *
	 * This method renames nested .git directories by adding/removing a suffix to temporarily disable/enable them.
	 * The root .git directory is preserved. Uses VS Code's workspace API to find nested .git directories and
	 * only processes actual directories (not files named .git).
	 *
	 * @param disable - If true, adds suffix to disable nested git repos. If false, removes suffix to re-enable them.
	 * @throws Error if renaming any .git directory fails
	 */
	public async renameNestedGitRepos(disable: boolean): Promise<void> {
		// Find all .git directories that are not at the root level using VS Code API
		const gitFiles = await vscode.workspace.findFiles(
			new vscode.RelativePattern(this.cwd, "**/.git" + (disable ? "" : GIT_DISABLED_SUFFIX)),
			new vscode.RelativePattern(this.cwd, ".git/**"), // Exclude root .git
		)

		// Filter to only include directories
		const gitPaths: string[] = []
		for (const file of gitFiles) {
			const relativePath = path.relative(this.cwd, file.fsPath)
			try {
				const stats = await fs.stat(path.join(this.cwd, relativePath))
				if (stats.isDirectory()) {
					gitPaths.push(relativePath)
				}
			} catch {
				// Skip if stat fails
				continue
			}
		}

		// For each nested .git directory, rename it based on the disable flag
		for (const gitPath of gitPaths) {
			const fullPath = path.join(this.cwd, gitPath)
			let newPath: string
			if (disable) {
				newPath = fullPath + GIT_DISABLED_SUFFIX
			} else {
				newPath = fullPath.endsWith(GIT_DISABLED_SUFFIX) ? fullPath.slice(0, -GIT_DISABLED_SUFFIX.length) : fullPath
			}

			try {
				await fs.rename(fullPath, newPath)
				console.info(`${disable ? "Disabled" : "Enabled"} nested git repo ${gitPath}`)
			} catch (error) {
				console.error(`Failed to ${disable ? "disable" : "enable"} nested git repo ${gitPath}:`, error)
			}
		}
	}

	/**
	 * Switches to or creates a task-specific branch in the shadow Git repository.
	 * For legacy checkpoints, this is a no-op since they use separate repositories.
	 * For branch-per-task checkpoints, this ensures we're on the correct task branch before operations.
	 *
	 * The method performs the following:
	 * 1. Gets the shadow git path and initializes simple-git
	 * 2. Constructs the branch name using the task ID
	 * 3. Checks if the branch exists:
	 *    - If not, creates a new branch
	 *    - If yes, switches to the existing branch
	 * 4. Verifies the branch switch completed successfully
	 *
	 * Branch naming convention:
	 * task-{taskId}
	 *
	 * @param taskId - The ID of the task whose branch to switch to
	 * @param gitPath - Path to the .git directory
	 * @returns Promise<void>
	 * @throws Error if branch operations fail or git commands error
	 */
	public async switchToTaskBranch(taskId: string, gitPath: string): Promise<void> {
		const git = simpleGit(path.dirname(gitPath))
		const branchName = `task-${taskId}`

		// Create new task-specific branch, or switch to one if it already exists.
		const branches = await git.branchLocal()
		if (!branches.all.includes(branchName)) {
			console.info(`Creating new task branch: ${branchName}`)
			await git.checkoutLocalBranch(branchName)
		} else {
			console.info(`Switching to existing task branch: ${branchName}`)
			await git.checkout(branchName)
		}

		const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"])
		console.info(`Current Checkpoint branch after switch: ${currentBranch}`)
	}

	/**
	 * Adds files to the shadow git repository while handling nested git repos.
	 * Uses git commands to list files and stages them for commit.
	 * Respects .gitignore and handles LFS patterns.
	 *
	 * Process:
	 * 1. Updates exclude patterns from LFS config
	 * 2. Temporarily disables nested git repos
	 * 3. Gets list of tracked and untracked files from git (respecting .gitignore)
	 * 4. Adds all files to git staging
	 * 5. Re-enables nested git repos
	 *
	 * @param git - SimpleGit instance configured for the shadow git repo
	 * @param gitPath - Path to the .git directory
	 * @returns Promise<CheckpointAddResult> Object containing success status, message, and file count
	 * @throws Error if:
	 *  - File operations fail
	 *  - Git commands error
	 *  - LFS pattern updates fail
	 *  - Nested git repo handling fails
	 */
	public async addCheckpointFiles(git: SimpleGit, gitPath: string): Promise<CheckpointAddResult> {
		try {
			// Update exclude patterns before each commit
			await writeExcludesFile(gitPath, await getLfsPatterns(this.cwd))
			await this.renameNestedGitRepos(true)
			//console.info("Starting checkpoint add operation...")

			// Get list of all files git would track (respects .gitignore)
			await git.addConfig("core.quotePath", "false")
			await git.addConfig("core.precomposeunicode", "true")
			const gitFiles = (await git.raw(["ls-files", "--others", "--exclude-standard", "--cached"]))
				.split("\n")
				.filter(Boolean)

			// Add filtered files
			if (gitFiles.length === 0) {
				console.info("No files to add to checkpoint")
				return { success: true, fileCount: 0 }
			}

			try {
				console.info(`Adding ${gitFiles.length} files to checkpoint`)
				await git.addConfig("core.quotePath", "false")
				await git.addConfig("core.precomposeunicode", "true")
				await git.add(gitFiles)
				console.info("Checkpoint add operation completed successfully")
				return { success: true, fileCount: gitFiles.length }
			} catch (error) {
				console.error("Checkpoint add operation failed:", error)
				throw error
			}
		} catch (error) {
			console.error("Failed to add files to checkpoint", error)
			throw error
		} finally {
			await this.renameNestedGitRepos(false)
		}
	}
}

export const GIT_DISABLED_SUFFIX = "_disabled"
