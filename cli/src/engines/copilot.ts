import { spawnSync } from "node:child_process";
import { logDebug } from "../ui/logger.ts";
import { BaseAIEngine, checkForErrors, formatCommandError } from "./base.ts";
import type { AIResult, EngineOptions } from "./types.ts";

const isWindows = process.platform === "win32";

/**
 * GitHub Copilot CLI AI Engine
 *
 * Note: This engine intentionally does NOT implement executeStreaming
 * because Copilot CLI has issues with streaming output on Windows.
 * Using the non-streaming execute() method produces more reliable results.
 *
 * Uses spawnSync instead of async spawn to avoid hanging issues on Windows.
 */
export class CopilotEngine extends BaseAIEngine {
	name = "GitHub Copilot";
	cliCommand = "copilot";

	/**
	 * Sanitize prompt for Windows cmd.exe
	 * On Windows, prompts with special characters need careful handling
	 */
	private sanitizePromptForWindows(prompt: string): string {
		if (!isWindows) {
			return prompt;
		}

		// On Windows, we need to handle special characters
		// Replace actual newlines with space for readability
		let sanitized = prompt;
		sanitized = sanitized.replace(/\r\n/g, " ").replace(/\n/g, " ");

		// Escape double quotes by doubling them (cmd.exe convention)
		// Since we'll wrap the whole prompt in quotes, internal quotes need to be escaped
		sanitized = sanitized.replace(/"/g, '""');

		return sanitized;
	}

	async execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult> {
		// Debug logging
		logDebug(`[Copilot] Working directory: ${workDir}`);
		logDebug(`[Copilot] Prompt length: ${prompt.length} chars`);
		logDebug(`[Copilot] Prompt preview: ${prompt.substring(0, 200)}...`);

		const startTime = Date.now();

		// Use spawnSync to avoid hanging issues with Bun.spawn on Windows
		// The Copilot CLI seems to not close its streams properly which causes
		// async stream reading to hang indefinitely
		let result;

		if (isWindows) {
			// On Windows with shell: true, we need to build the command as a single string
			// with proper quoting to avoid argument splitting
			const sanitizedPrompt = this.sanitizePromptForWindows(prompt);

			// Build optional args
			const extraArgs: string[] = [];
			if (options?.modelOverride) {
				extraArgs.push("--model", options.modelOverride);
			}
			if (options?.engineArgs && options.engineArgs.length > 0) {
				extraArgs.push(...options.engineArgs);
			}

			// Build the full command string with the prompt in quotes
			const extraArgsStr = extraArgs.length > 0 ? ` ${extraArgs.join(" ")}` : "";
			const fullCommand = `${this.cliCommand} --yolo -p "${sanitizedPrompt}"${extraArgsStr}`;

			logDebug(`[Copilot] Command (first 300 chars): ${fullCommand.substring(0, 300)}...`);

			result = spawnSync(fullCommand, [], {
				cwd: workDir,
				encoding: "utf-8",
				shell: true, // Required on Windows for .cmd wrappers
				timeout: 5 * 60 * 1000, // 5 minute timeout
				maxBuffer: 10 * 1024 * 1024, // 10MB buffer
			});
		} else {
			// On Unix, we can pass args as an array without shell
			const args: string[] = ["--yolo", "-p", prompt];
			if (options?.modelOverride) {
				args.push("--model", options.modelOverride);
			}
			if (options?.engineArgs && options.engineArgs.length > 0) {
				args.push(...options.engineArgs);
			}

			result = spawnSync(this.cliCommand, args, {
				cwd: workDir,
				encoding: "utf-8",
				timeout: 5 * 60 * 1000, // 5 minute timeout
				maxBuffer: 10 * 1024 * 1024, // 10MB buffer
			});
		}

		const durationMs = Date.now() - startTime;

		const stdout = result.stdout || "";
		const stderr = result.stderr || "";
		const exitCode = result.status ?? 1;
		const output = stdout + stderr;

		// Debug logging
		logDebug(`[Copilot] Exit code: ${exitCode}`);
		logDebug(`[Copilot] Duration: ${durationMs}ms`);
		logDebug(`[Copilot] Output length: ${output.length} chars`);
		logDebug(`[Copilot] Output preview: ${output.substring(0, 500)}...`);

		// Check for timeout
		if (result.signal === "SIGTERM") {
			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error: "Copilot CLI timed out after 5 minutes",
			};
		}

		// Check for JSON errors (from base)
		const jsonError = checkForErrors(output);
		if (jsonError) {
			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error: jsonError,
			};
		}

		// Check for Copilot-specific errors (plain text)
		const copilotError = this.checkCopilotErrors(output);
		if (copilotError) {
			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error: copilotError,
			};
		}

		// Parse Copilot output - extract response from output
		const response = this.parseOutput(output);

		// If command failed with non-zero exit code, provide a meaningful error
		if (exitCode !== 0) {
			return {
				success: false,
				response,
				inputTokens: 0,
				outputTokens: 0,
				error: formatCommandError(exitCode, output),
			};
		}

		return {
			success: true,
			response,
			inputTokens: 0, // Copilot CLI doesn't expose token counts in programmatic mode
			outputTokens: 0,
			cost: durationMs > 0 ? `duration:${durationMs}` : undefined,
		};
	}

	/**
	 * Check for Copilot-specific errors in output
	 * Copilot CLI outputs plain text errors (not JSON) and may return exit code 0
	 */
	private checkCopilotErrors(output: string): string | null {
		const lower = output.toLowerCase();
		const trimmed = output.trim();

		// Authentication errors
		if (lower.includes("no authentication") || lower.includes("not authenticated")) {
			return "GitHub Copilot CLI is not authenticated. Run 'copilot' and use '/login' to authenticate, or set COPILOT_GITHUB_TOKEN environment variable.";
		}

		// Rate limiting
		if (lower.includes("rate limit") || lower.includes("too many requests")) {
			return "GitHub Copilot rate limit exceeded. Please wait and try again.";
		}

		// Network errors
		if (lower.includes("network error") || lower.includes("connection refused")) {
			return "Network error connecting to GitHub Copilot. Check your internet connection.";
		}

		// Generic error detection - check trimmed output and case-insensitive
		if (trimmed.toLowerCase().startsWith("error:") || lower.includes("\nerror:")) {
			// Extract the error message
			const match = output.match(/error:\s*(.+?)(?:\n|$)/i);
			if (match) {
				return match[1].trim();
			}
			return "GitHub Copilot CLI returned an error";
		}

		return null;
	}

	private parseOutput(output: string): string {
		// Copilot CLI may output text responses
		// Extract the meaningful response, filtering out control characters and prompts
		// Note: These filter patterns are specific to current Copilot CLI behavior
		// and may need updates if the CLI output format changes
		const lines = output.split("\n").filter(Boolean);

		// Filter out empty lines and common CLI artifacts
		const meaningfulLines = lines.filter((line) => {
			const trimmed = line.trim();
			return (
				trimmed &&
				!trimmed.startsWith("?") && // Interactive prompts
				!trimmed.startsWith("❯") && // Command prompts
				!trimmed.includes("Thinking...") && // Status messages
				!trimmed.includes("Working on it...") // Status messages
			);
		});

		return meaningfulLines.join("\n") || "Task completed";
	}

	// Note: executeStreaming is intentionally NOT implemented for Copilot
	// because it has reliability issues on Windows with complex prompts.
	// The base execute() method is more reliable.
}
