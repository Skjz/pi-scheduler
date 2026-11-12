import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_TASKS } from "./constants";
import { formatDurationShort, parseLoopScheduleArgs, parseRemindScheduleArgs } from "./scheduling";
import { SchedulerRuntime } from "./runtime";

export function registerCommands(pi: ExtensionAPI, runtime: SchedulerRuntime) {
	pi.registerCommand("loop", {
		description:
			"Schedule recurring prompt: /loop 5m <prompt>, /loop <prompt> every 2h, or /loop cron <expr> <prompt>",
		handler: async (args, ctx) => {
			const parsed = parseLoopScheduleArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /loop 5m check build OR /loop cron '*/5 * * * *' check build", "warning");
				return;
			}

			if (runtime.taskCount >= MAX_TASKS) {
				ctx.ui.notify(`Task limit reached (${MAX_TASKS}). Delete one with /schedule delete <id>.`, "error");
				return;
			}

			if (parsed.recurring.mode === "cron") {
				const task = runtime.addRecurringCronTask(parsed.prompt, parsed.recurring.cronExpression);
				if (!task) {
					ctx.ui.notify("Invalid cron schedule; could not compute next run.", "error");
					return;
				}
				ctx.ui.notify(`Scheduled cron ${task.cronExpression} (id: ${task.id}). Expires in 3 days.`, "info");
				if (parsed.recurring.note) ctx.ui.notify(parsed.recurring.note, "info");
				return;
			}

			const task = runtime.addRecurringIntervalTask(parsed.prompt, parsed.recurring.durationMs);
			ctx.ui.notify(
				`Scheduled every ${formatDurationShort(parsed.recurring.durationMs)} (id: ${task.id}). Expires in 3 days.`,
				"info",
			);
			if (parsed.recurring.note) ctx.ui.notify(parsed.recurring.note, "info");
		},
	});

	pi.registerCommand("remind", {
		description: "Schedule one-time reminder: /remind in 45m <prompt>",
		handler: async (args, ctx) => {
			const parsed = parseRemindScheduleArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /remind in 45m check deployment", "warning");
				return;
			}

			if (runtime.taskCount >= MAX_TASKS) {
				ctx.ui.notify(`Task limit reached (${MAX_TASKS}). Delete one with /schedule delete <id>.`, "error");
				return;
			}

			const task = runtime.addOneShotTask(parsed.prompt, parsed.durationMs);
			ctx.ui.notify(`Reminder set for ${runtime.formatRelativeTime(task.nextRunAt)} (id: ${task.id}).`, "info");
			if (parsed.note) ctx.ui.notify(parsed.note, "info");
		},
	});

	pi.registerCommand("schedule", {
		description:
			"Manage schedules. No args opens TUI manager. Also: list | enable <id> | disable <id> | delete <id> | claim <id> | claim --all [--from <id>] | clear [--all]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "tui") {
				await runtime.openTaskManager(ctx);
				return;
			}

			const [rawAction, rawArg] = trimmed.split(/\s+/, 2);
			const action = rawAction.toLowerCase();

			if (action === "list") {
				pi.sendMessage({
					customType: "pi-scheduler",
					content: runtime.formatTaskList(),
					display: true,
				});
				return;
			}

			if (action === "enable" || action === "disable") {
				if (!rawArg) {
					ctx.ui.notify(`Usage: /schedule ${action} <id>`, "warning");
					return;
				}
				const enabled = action === "enable";
				const ok = runtime.setTaskEnabled(rawArg, enabled);
				if (!ok) {
					ctx.ui.notify(`Task not found: ${rawArg}`, "warning");
					return;
				}
				ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"} scheduled task ${rawArg}.`, "info");
				return;
			}

			if (action === "delete" || action === "remove" || action === "rm") {
				if (!rawArg) {
					ctx.ui.notify("Usage: /schedule delete <id>", "warning");
					return;
				}
				const removed = runtime.deleteTask(rawArg);
				if (!removed) {
					ctx.ui.notify(`Task not found: ${rawArg}`, "warning");
					return;
				}
				ctx.ui.notify(`Deleted scheduled task ${rawArg}.`, "info");
				return;
			}

			if (action === "claim") {
				const sessionId = runtime.sessionId;
				if (!sessionId) {
					ctx.ui.notify("Cannot determine current session id.", "warning");
					return;
				}

				if (rawArg === "--all") {
					const rest = trimmed.split(/\s+/).slice(2);
					const fromIndex = rest.indexOf("--from");
					const fromSessionId = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
					const result = runtime.claimAll(sessionId, runtime.sessionName, fromSessionId);
					if (result.claimed === 0) {
						ctx.ui.notify("No tasks to claim.", "info");
						return;
					}
					ctx.ui.notify(`Claimed ${result.claimed} task(s) to this session: ${result.ids.join(", ")}`, "info");
					return;
				}

				if (!rawArg) {
					ctx.ui.notify("Usage: /schedule claim <id> | /schedule claim --all [--from <sessionId>]", "warning");
					return;
				}

				const result = runtime.claimTask(rawArg, sessionId, runtime.sessionName);
				if (!result.ok) {
					ctx.ui.notify(
						result.reason === "already_owned"
							? `Task ${rawArg} already belongs to this session.`
							: `Task not found: ${rawArg}`,
						"warning",
					);
					return;
				}
				const from = result.from ? ` (from ${result.from.slice(0, 8)})` : " (previously unowned)";
				ctx.ui.notify(`Claimed ${rawArg} to this session${from}.`, "info");
				return;
			}

			if (action === "clear") {
				if (rawArg === "--all") {
					const count = runtime.clearTasks();
					ctx.ui.notify(`Cleared ${count} task${count === 1 ? "" : "s"}.`, "info");
					return;
				}

				const sessionId = runtime.sessionId;
				if (!sessionId) {
					ctx.ui.notify("Cannot determine current session id. Use /schedule clear --all to clear everything.", "warning");
					return;
				}
				const count = runtime.clearTasks(sessionId);
				ctx.ui.notify(
					`Cleared ${count} task${count === 1 ? "" : "s"}. Tasks owned by other sessions were kept (use /schedule clear --all to remove them).`,
					"info",
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /schedule [tui|list|enable <id>|disable <id>|delete <id>|claim <id>|claim --all [--from <id>]|clear [--all]]",
				"warning",
			);
		},
	});

	pi.registerCommand("unschedule", {
		description: "Alias for /schedule delete <id>",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /unschedule <id>", "warning");
				return;
			}
			const removed = runtime.deleteTask(id);
			if (!removed) {
				ctx.ui.notify(`Task not found: ${id}`, "warning");
				return;
			}
			ctx.ui.notify(`Deleted scheduled task ${id}.`, "info");
		},
	});
}
