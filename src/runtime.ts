import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LOOP_INTERVAL, FIFTEEN_MINUTES, ONE_MINUTE, THREE_DAYS } from "./constants";
import { LeaseManager } from "./lease";
import {
	computeNextCronRunAt,
	formatDurationShort,
	normalizeCronExpression,
	normalizeDuration,
	parseDuration,
} from "./scheduling";
import {
	isVisible,
	mergeTasks,
	normalizeTask,
	pruneTombstones,
	readStore,
	writeStore,
} from "./store";
import type { ScheduleTask } from "./types";

export type ClaimFailure = "not_found" | "already_owned";

export interface ClaimResult {
	ok: boolean;
	reason?: ClaimFailure;
	/** 认领前的所有者会话，用于提示 */
	from?: string;
	task?: ScheduleTask;
}

export class SchedulerRuntime {
	private readonly tasks = new Map<string, ScheduleTask>();
	private schedulerTimer: NodeJS.Timeout | undefined;
	private runtimeCtx: ExtensionContext | undefined;
	private dispatching = false;
	private storagePath: string | undefined;
	private lease: LeaseManager | undefined;
	private currentSessionId: string | undefined;
	private currentSessionName: string | undefined;
	/** 上次读到的存储文件签名（mtime:size），用于发现其它窗口的改动 */
	private lastStoreSignature: string | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	/** 当前会话 id，供命令层构造归属信息 */
	get sessionId(): string | undefined {
		return this.currentSessionId;
	}

	get sessionName(): string | undefined {
		return this.currentSessionName;
	}

	get taskCount(): number {
		return this.visibleTasks().length;
	}

	private visibleTasks(): ScheduleTask[] {
		return Array.from(this.tasks.values()).filter(isVisible);
	}

	setRuntimeContext(ctx: ExtensionContext | undefined) {
		this.runtimeCtx = ctx;
		if (!ctx?.cwd) return;

		this.currentSessionId = ctx.sessionManager?.getSessionId();
		this.currentSessionName = this.readSessionName(ctx);

		const nextStorePath = path.join(ctx.cwd, ".pi", "scheduler.json");
		if (nextStorePath !== this.storagePath) {
			this.lease?.release();
			this.storagePath = nextStorePath;
			this.lease = new LeaseManager({
				filePath: path.join(ctx.cwd, ".pi", "scheduler.lock"),
				sessionId: this.currentSessionId ?? "unknown",
			});
			this.loadTasksFromDisk();
			return;
		}

		// 同一工作目录内切换会话（/new、resume、fork）：执行权不变，只更新归属标识
		if (this.currentSessionId) this.lease?.setSessionId(this.currentSessionId);
	}

	private readSessionName(ctx: ExtensionContext): string | undefined {
		try {
			const name = ctx.sessionManager?.getSessionName?.();
			return name && name.trim() ? name.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	clearStatus(ctx?: ExtensionContext) {
		const target = ctx ?? this.runtimeCtx;
		if (target?.hasUI) target.ui.setStatus("pi-scheduler", undefined);
	}

	getSortedTasks(): ScheduleTask[] {
		return this.visibleTasks().sort((a, b) => a.nextRunAt - b.nextRunAt);
	}

	getTask(id: string): ScheduleTask | undefined {
		const task = this.tasks.get(id);
		if (!task || !isVisible(task)) return undefined;
		return task;
	}

	setTaskEnabled(id: string, enabled: boolean): boolean {
		const task = this.getTask(id);
		if (!task) return false;
		task.enabled = enabled;
		if (!enabled) task.pending = false;
		task.updatedAt = Date.now();
		this.persistTasks();
		this.updateStatus();
		return true;
	}

	deleteTask(id: string): boolean {
		const task = this.getTask(id);
		if (!task) return false;
		// 软删除：保留墓碑，让其它窗口下次同步时也删掉它，
		// 否则那些窗口内存里的旧数据会把它写回来。
		const now = Date.now();
		task.deletedAt = now;
		task.updatedAt = now;
		task.pending = false;
		this.persistTasks();
		this.updateStatus();
		return true;
	}

	/**
	 * 清空任务。传入会话 id 时只清该会话拥有的任务（含无主任务），
	 * 不传则清空本目录下全部任务。
	 */
	clearTasks(onlyOwnedBy?: string): number {
		const now = Date.now();
		let count = 0;
		for (const task of this.visibleTasks()) {
			if (onlyOwnedBy && task.ownerSessionId && task.ownerSessionId !== onlyOwnedBy) continue;
			task.deletedAt = now;
			task.updatedAt = now;
			task.pending = false;
			count += 1;
		}
		if (count > 0) this.persistTasks();
		this.updateStatus();
		return count;
	}

	formatRelativeTime(timestamp: number): string {
		const delta = timestamp - Date.now();
		if (delta <= 0) return "due now";
		const mins = Math.round(delta / ONE_MINUTE);
		if (mins < 60) return `in ${Math.max(mins, 1)}m`;
		const hours = Math.round(mins / 60);
		if (hours < 48) return `in ${hours}h`;
		const days = Math.round(hours / 24);
		return `in ${days}d`;
	}

	formatTaskList(): string {
		const list = this.getSortedTasks();
		if (list.length === 0) return "No scheduled tasks.";

		const lines = ["Scheduled tasks:", ""];
		for (const task of list) {
			const state = task.enabled ? "on" : "off";
			const mode = this.taskMode(task);
			const next = `${this.formatRelativeTime(task.nextRunAt)} (${this.formatClock(task.nextRunAt)})`;
			const last = task.lastRunAt ? `${this.formatRelativeTime(task.lastRunAt)} (${this.formatClock(task.lastRunAt)})` : "never";
			const status = task.lastStatus ?? "pending";
			const preview = task.prompt.length > 72 ? `${task.prompt.slice(0, 69)}...` : task.prompt;
			lines.push(`${task.id}  ${state}  ${mode}  next ${next}${this.ownerLabel(task)}`);
			lines.push(`  runs=${task.runCount}  last=${last}  status=${status}`);
			lines.push(`  ${preview}`);
		}
		return lines.join("\n");
	}

	/** 新任务的归属字段：记录创建它的会话，便于状态栏按会话分组。 */
	private ownerFields(): Pick<ScheduleTask, "ownerSessionId" | "ownerSessionName" | "updatedAt"> {
		return {
			ownerSessionId: this.currentSessionId,
			ownerSessionName: this.currentSessionName,
			updatedAt: Date.now(),
		};
	}

	addRecurringIntervalTask(prompt: string, intervalMs: number): ScheduleTask {
		const id = this.createId();
		const createdAt = Date.now();
		const jitterMs = this.computeJitterMs(id, intervalMs);
		const nextRunAt = createdAt + intervalMs + jitterMs;
		const task: ScheduleTask = {
			id,
			prompt,
			kind: "recurring",
			enabled: true,
			createdAt,
			nextRunAt,
			intervalMs,
			expiresAt: createdAt + THREE_DAYS,
			jitterMs,
			runCount: 0,
			pending: false,
			...this.ownerFields(),
		};
		this.tasks.set(id, task);
		this.persistTasks();
		this.updateStatus();
		return task;
	}

	addRecurringCronTask(prompt: string, cronExpression: string): ScheduleTask | undefined {
		const id = this.createId();
		const createdAt = Date.now();
		const nextRunAt = computeNextCronRunAt(cronExpression, createdAt);
		if (!nextRunAt) return undefined;

		const task: ScheduleTask = {
			id,
			prompt,
			kind: "recurring",
			enabled: true,
			createdAt,
			nextRunAt,
			cronExpression,
			expiresAt: createdAt + THREE_DAYS,
			jitterMs: 0,
			runCount: 0,
			pending: false,
			...this.ownerFields(),
		};
		this.tasks.set(id, task);
		this.persistTasks();
		this.updateStatus();
		return task;
	}

	addOneShotTask(prompt: string, delayMs: number): ScheduleTask {
		const id = this.createId();
		const createdAt = Date.now();
		const task: ScheduleTask = {
			id,
			prompt,
			kind: "once",
			enabled: true,
			createdAt,
			nextRunAt: createdAt + delayMs,
			jitterMs: 0,
			runCount: 0,
			pending: false,
			...this.ownerFields(),
		};
		this.tasks.set(id, task);
		this.persistTasks();
		this.updateStatus();
		return task;
	}

	startScheduler() {
		if (this.schedulerTimer) return;
		this.schedulerTimer = setInterval(() => {
			void this.tickScheduler();
		}, 1000);
	}

	stopScheduler() {
		if (!this.schedulerTimer) return;
		clearInterval(this.schedulerTimer);
		this.schedulerTimer = undefined;
		// 主动让位，其它窗口不必等到心跳超时
		this.lease?.release();
	}

	/**
	 * 状态栏只统计当前会话的任务。任务仍然按工作目录共享存储，
	 * 但把别的会话的任务摆到本窗口上只会制造困惑。
	 */
	updateStatus() {
		if (!this.runtimeCtx?.hasUI) return;
		const visible = this.visibleTasks();
		if (visible.length === 0) {
			this.runtimeCtx.ui.setStatus("pi-scheduler", undefined);
			return;
		}

		const enabled = visible.filter((t) => t.enabled);
		if (enabled.length === 0) {
			this.runtimeCtx.ui.setStatus("pi-scheduler", `⏸ ${visible.length} task${visible.length === 1 ? "" : "s"} paused`);
			return;
		}

		const mine = enabled.filter((t) => t.ownerSessionId && t.ownerSessionId === this.currentSessionId);
		const unowned = enabled.filter((t) => !t.ownerSessionId);
		const others = enabled.filter((t) => t.ownerSessionId && t.ownerSessionId !== this.currentSessionId);

		if (mine.length === 0) {
			// 无主任务（历史遗留）单独标出来，提醒用户可以用 claim 收回
			const parts: string[] = [];
			if (unowned.length > 0) parts.push(`${unowned.length} to claim`);
			if (others.length > 0) parts.push(`${others.length} other session${others.length === 1 ? "" : "s"}`);
			this.runtimeCtx.ui.setStatus("pi-scheduler", `⏰ ${parts.join(" • ")}`);
			return;
		}

		const nextRunAt = Math.min(...mine.map((t) => t.nextRunAt));
		const extras: string[] = [];
		if (unowned.length > 0) extras.push(`+${unowned.length} to claim`);
		if (others.length > 0) extras.push(`+${others.length} other session${others.length === 1 ? "" : "s"}`);
		const suffix = extras.length > 0 ? ` (${extras.join(" ")})` : "";
		this.runtimeCtx.ui.setStatus("pi-scheduler", `⏰ ${mine.length} active • next ${this.formatClock(nextRunAt)}${suffix}`);
	}

	/** 无主任务不属于任何会话，只能通过 claim 显式归属。 */
	async tickScheduler() {
		if (!this.runtimeCtx) return;

		// 先把其它窗口的改动拉进来，否则状态栏和调度判定都是基于旧快照
		this.syncFromDiskIfChanged();

		// 执行权：同一工作目录下多个 pi 进程，只允许一个 tick 并 dispatch
		const state = this.lease ? this.lease.acquire() : "leader";

		const now = Date.now();
		let mutated = false;

		for (const task of Array.from(this.tasks.values())) {
			if (!isVisible(task)) continue;
			if (task.kind === "recurring" && task.expiresAt && now >= task.expiresAt) {
				// 转为墓碑而非直接删掉，让其它窗口也能收到这个过期
				task.deletedAt = now;
				task.updatedAt = now;
				mutated = true;
				continue;
			}

			if (!task.enabled) continue;
			if (now >= task.nextRunAt) {
				task.pending = true;
			}
		}

		// 只有 leader 落盘，避免多个进程互相覆盖
		if (mutated && state === "leader") this.persistTasks();
		this.updateStatus();

		if (state !== "leader") return;
		if (this.dispatching) return;
		if (!this.runtimeCtx.isIdle() || this.runtimeCtx.hasPendingMessages()) return;

		const nextTask = Array.from(this.tasks.values())
			.filter((task) => isVisible(task) && task.enabled && task.pending)
			.sort((a, b) => a.nextRunAt - b.nextRunAt)[0];

		if (!nextTask) return;

		this.dispatching = true;
		try {
			this.dispatchTask(nextTask);
		} finally {
			this.dispatching = false;
		}
	}

	async openTaskManager(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			this.pi.sendMessage({
				customType: "pi-scheduler",
				content: this.formatTaskList(),
				display: true,
			});
			return;
		}

		while (true) {
			const list = this.getSortedTasks();
			if (list.length === 0) {
				ctx.ui.notify("No scheduled tasks.", "info");
				return;
			}

			const options = list.map((task) => this.taskOptionLabel(task));
			options.push("➕ Close");

			const selected = await ctx.ui.select("Scheduled tasks (select one)", options);
			if (!selected || selected === "➕ Close") return;

			const taskId = selected.slice(0, 8);
			const task = this.getTask(taskId);
			if (!task) {
				ctx.ui.notify("Task no longer exists. Refreshing list...", "warning");
				continue;
			}

			const closed = await this.openTaskActions(ctx, task.id);
			if (closed) return;
		}
	}

	private async openTaskActions(ctx: ExtensionContext, taskId: string): Promise<boolean> {
		while (true) {
			const task = this.getTask(taskId);
			if (!task) {
				ctx.ui.notify("Task no longer exists.", "warning");
				return false;
			}

			const title = `${task.id} • ${this.taskMode(task)} • next ${this.formatRelativeTime(task.nextRunAt)} (${this.formatClock(task.nextRunAt)})`;
			const options = [
				task.kind === "recurring" ? "⏱ Change schedule" : "⏱ Change reminder delay",
				task.enabled ? "⏸ Disable" : "▶ Enable",
				"▶ Run now",
			];
			if (this.isClaimable(task)) options.push("📥 Claim to this session");
			options.push("🗑 Delete", "↩ Back", "✕ Close");
			const action = await ctx.ui.select(title, options);

			if (!action || action === "↩ Back") return false;
			if (action === "✕ Close") return true;

			if (action === "📥 Claim to this session") {
				const sessionId = this.currentSessionId;
				if (!sessionId) {
					ctx.ui.notify("Cannot determine current session id.", "warning");
					continue;
				}
				const result = this.claimTask(task.id, sessionId, this.currentSessionName);
				if (result.ok) {
					ctx.ui.notify(`Claimed ${task.id} to this session.`, "info");
				} else {
					ctx.ui.notify(`Could not claim ${task.id}: ${result.reason}.`, "warning");
				}
				continue;
			}

			if (action === "⏸ Disable" || action === "▶ Enable") {
				const enabled = action === "▶ Enable";
				this.setTaskEnabled(task.id, enabled);
				ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"} scheduled task ${task.id}.`, "info");
				continue;
			}

			if (action === "🗑 Delete") {
				const ok = await ctx.ui.confirm("Delete scheduled task?", `${task.id}: ${task.prompt}`);
				if (!ok) continue;
				this.deleteTask(task.id);
				ctx.ui.notify(`Deleted scheduled task ${task.id}.`, "info");
				return false;
			}

			if (action === "▶ Run now") {
				task.nextRunAt = Date.now();
				task.pending = true;
				this.persistTasks();
				this.updateStatus();
				void this.tickScheduler();
				ctx.ui.notify(`Queued ${task.id} to run now.`, "info");
				continue;
			}

			if (action.startsWith("⏱")) {
				const defaultValue =
					task.kind === "recurring"
						? task.cronExpression ?? formatDurationShort(task.intervalMs ?? DEFAULT_LOOP_INTERVAL)
						: formatDurationShort(Math.max(task.nextRunAt - Date.now(), ONE_MINUTE));

				const raw = await ctx.ui.input(
					task.kind === "recurring"
						? "New interval or cron (e.g. 5m or 0 */10 * * * *)"
						: "New delay from now (e.g. 30m, 2h)",
					defaultValue,
				);
				if (!raw) continue;

				if (task.kind === "recurring") {
					const parsedDuration = parseDuration(raw);
					if (parsedDuration) {
						const normalized = normalizeDuration(parsedDuration);
						task.intervalMs = normalized.durationMs;
						task.cronExpression = undefined;
						task.jitterMs = this.computeJitterMs(task.id, normalized.durationMs);
						task.nextRunAt = Date.now() + normalized.durationMs + task.jitterMs;
						task.pending = false;
						this.persistTasks();
						ctx.ui.notify(`Updated ${task.id} to every ${formatDurationShort(normalized.durationMs)}.`, "info");
						if (normalized.note) ctx.ui.notify(normalized.note, "info");
						this.updateStatus();
						continue;
					}

					const normalizedCron = normalizeCronExpression(raw);
					if (!normalizedCron) {
						ctx.ui.notify("Invalid input. Use interval like 5m or cron like 0 */10 * * * *.", "warning");
						continue;
					}

					const nextRunAt = computeNextCronRunAt(normalizedCron.expression);
					if (!nextRunAt) {
						ctx.ui.notify("Could not compute next cron run time.", "warning");
						continue;
					}

					task.intervalMs = undefined;
					task.cronExpression = normalizedCron.expression;
					task.jitterMs = 0;
					task.nextRunAt = nextRunAt;
					task.pending = false;
					this.persistTasks();
					ctx.ui.notify(`Updated ${task.id} to cron ${normalizedCron.expression}.`, "info");
					if (normalizedCron.note) ctx.ui.notify(normalizedCron.note, "info");
					this.updateStatus();
					continue;
				}

				const parsed = parseDuration(raw);
				if (!parsed) {
					ctx.ui.notify("Invalid duration. Try values like 5m, 2h, or 1 day.", "warning");
					continue;
				}

				const normalized = normalizeDuration(parsed);
				task.nextRunAt = Date.now() + normalized.durationMs;
				task.pending = false;
				this.persistTasks();
				ctx.ui.notify(`Updated ${task.id} reminder to ${this.formatRelativeTime(task.nextRunAt)}.`, "info");
				if (normalized.note) ctx.ui.notify(normalized.note, "info");
				this.updateStatus();
			}
		}
	}

	private dispatchTask(task: ScheduleTask) {
		if (!task.enabled || !isVisible(task)) return;
		// 认领或心跳超时可能刚把执行权转走，dispatch 前再确认一次
		if (this.lease && !this.lease.isLeader()) return;

		const now = Date.now();

		try {
			this.pi.sendUserMessage(this.buildDispatchPayload(task));
		} catch {
			task.pending = true;
			task.lastStatus = "error";
			this.persistTasks();
			return;
		}

		task.pending = false;
		task.lastRunAt = now;
		task.lastStatus = "success";
		task.runCount += 1;
		task.updatedAt = now;

		if (task.kind === "once") {
			task.deletedAt = now;
			this.persistTasks();
			this.updateStatus();
			return;
		}

		if (task.cronExpression) {
			const next = computeNextCronRunAt(task.cronExpression, now + 1_000);
			if (!next) {
				task.deletedAt = now;
				this.persistTasks();
				this.updateStatus();
				return;
			}
			task.nextRunAt = next;
			this.persistTasks();
			this.updateStatus();
			return;
		}

		const intervalMs = task.intervalMs ?? DEFAULT_LOOP_INTERVAL;
		let next = task.nextRunAt;
		while (next <= now) next += intervalMs;
		task.nextRunAt = next;
		this.persistTasks();
		this.updateStatus();
	}

	/**
	 * owner 不在本会话时，说明这条任务是被兜底接管的。
	 * 不标注来源的话，用户会看到一条与自己当前对话无关的指令。
	 */
	private buildDispatchPayload(task: ScheduleTask): string {
		const owner = task.ownerSessionId;
		if (owner && owner === this.currentSessionId) return task.prompt;

		const created = this.formatClock(task.createdAt);
		if (!owner) {
			// 无主任务：无法判断是不是自己的，拧清楚并用 claim 收编
			return `⏰ [unowned task] Created at ${created} and not claimed by any session. Run /schedule claim ${task.id} to keep it here.\n\n${task.prompt}`;
		}

		const label = task.ownerSessionName ?? owner.slice(0, 8);
		return `⏰ [taken over] Task created in session "${label}" (${created}); that window is no longer running.\n\n${task.prompt}`;
	}

	private createId(): string {
		let id = "";
		do {
			id = Math.random().toString(36).slice(2, 10);
		} while (this.tasks.has(id));
		return id;
	}

	private taskMode(task: ScheduleTask): string {
		if (task.kind === "once") return "once";
		if (task.cronExpression) return `cron ${task.cronExpression}`;
		return `every ${formatDurationShort(task.intervalMs ?? DEFAULT_LOOP_INTERVAL)}`;
	}

	private taskOptionLabel(task: ScheduleTask): string {
		const state = task.enabled ? "✓" : "⏸";
		return `${task.id} • ${state} ${this.taskMode(task)} • ${this.formatRelativeTime(task.nextRunAt)}${this.ownerLabel(task)} • ${this.truncateText(task.prompt, 50)}`;
	}

	/** TUI 列表里的归属后缀，让用户看出哪些任务不属于本会话。 */
	private ownerLabel(task: ScheduleTask): string {
		if (!task.ownerSessionId) return " • to claim";
		if (task.ownerSessionId === this.currentSessionId) return "";
		return ` • other session (${task.ownerSessionName ?? task.ownerSessionId.slice(0, 8)})`;
	}

	private isClaimable(task: ScheduleTask): boolean {
		return task.ownerSessionId !== this.currentSessionId;
	}

	private truncateText(value: string, max = 64): string {
		if (value.length <= max) return value;
		return `${value.slice(0, Math.max(0, max - 3))}...`;
	}

	private formatClock(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	private hashString(input: string): number {
		let hash = 2166136261;
		for (let i = 0; i < input.length; i++) {
			hash ^= input.charCodeAt(i);
			hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
		}
		return hash >>> 0;
	}

	private computeJitterMs(taskId: string, intervalMs: number): number {
		const maxJitter = Math.min(Math.floor(intervalMs * 0.1), FIFTEEN_MINUTES);
		if (maxJitter <= 0) return 0;
		return this.hashString(taskId) % (maxJitter + 1);
	}

	private loadTasksFromDisk() {
		if (!this.storagePath) return;

		this.tasks.clear();
		const now = Date.now();
		const disk = readStore(this.storagePath);
		if (disk) {
			for (const raw of disk.tasks) {
				const task = normalizeTask(raw, now);
				if (!task) continue;
				// 已过期的 recurring 转为墓碑，不要直接从内存里蒸发，
				// 否则其它窗口还会把它写回来。
				if (!task.deletedAt && task.kind === "recurring" && task.expiresAt && now >= task.expiresAt) {
					task.deletedAt = now;
					task.updatedAt = now;
				}
				this.tasks.set(task.id, task);
			}
		}
		this.lastStoreSignature = this.storeSignature();
		this.updateStatus();
	}

	private storeSignature(): string | undefined {
		if (!this.storagePath) return undefined;
		try {
			const stat = fs.statSync(this.storagePath);
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return undefined;
		}
	}

	/**
	 * 存储文件被其它窗口改过时拉取最新内容。
	 * 原地合并（Object.assign）而不是重建对象，因为 TUI 管理器可能正持有任务引用。
	 */
	private syncFromDiskIfChanged() {
		if (!this.storagePath) return;
		const signature = this.storeSignature();
		if (signature === this.lastStoreSignature) return;
		this.lastStoreSignature = signature;

		const disk = readStore(this.storagePath);
		if (!disk) return;

		const now = Date.now();
		const seen = new Set<string>();
		for (const raw of disk.tasks) {
			const incoming = normalizeTask(raw, now);
			if (!incoming) continue;
			seen.add(incoming.id);

			const existing = this.tasks.get(incoming.id);
			if (!existing) {
				this.tasks.set(incoming.id, incoming);
				continue;
			}
			// pending 是本地运行时状态，磁盘上的值不算数
			const pending = existing.pending;
			Object.assign(existing, incoming);
			existing.pending = pending || incoming.pending;
		}

		for (const id of Array.from(this.tasks.keys())) {
			if (!seen.has(id)) this.tasks.delete(id);
		}
	}

	private persistTasks() {
		if (!this.storagePath) return;
		try {
			const now = Date.now();
			const disk = readStore(this.storagePath);
			// 关键：先读回磁盘现有内容再合并。
			// 直接覆盖会静默抹掉另一个窗口在期间新建/删除的任务。
			const merged = mergeTasks(Array.from(this.tasks.values()), disk?.tasks ?? []);
			writeStore(this.storagePath, pruneTombstones(merged, now));
		} catch {
			// 尽力而为：落盘失败不应中断调度
		}
	}

	/**
	 * 认领任务到指定会话。同时强制接管执行权，
	 * 否则原窗口仍是 leader，任务依旧会在那里被触发。
	 */
	claimTask(id: string, sessionId: string, sessionName?: string): ClaimResult {
		const task = this.getTask(id);
		if (!task) return { ok: false, reason: "not_found" };
		if (task.ownerSessionId === sessionId) return { ok: false, reason: "already_owned" };

		const from = this.applyClaim(task, sessionId, sessionName);
		this.persistTasks();
		this.updateStatus();
		this.lease?.forceAcquire();
		// 立即跑一次检查：逾期的一次性任务不必等下一个 tick
		void this.tickScheduler();
		return { ok: true, from, task };
	}

	/**
	 * 批量认领。不传 fromSessionId 时认领本目录下所有其它会话（含无主）的任务。
	 */
	claimAll(sessionId: string, sessionName?: string, fromSessionId?: string): { claimed: number; ids: string[] } {
		const ids: string[] = [];
		for (const task of this.visibleTasks()) {
			if (task.ownerSessionId === sessionId) continue;
			if (fromSessionId !== undefined && task.ownerSessionId !== fromSessionId) continue;
			this.applyClaim(task, sessionId, sessionName);
			ids.push(task.id);
		}

		if (ids.length > 0) {
			this.persistTasks();
			this.updateStatus();
			this.lease?.forceAcquire();
			void this.tickScheduler();
		}
		return { claimed: ids.length, ids };
	}

	/** 返回认领前的所有会话 id。 */
	private applyClaim(task: ScheduleTask, sessionId: string, sessionName?: string): string | undefined {
		const now = Date.now();
		const from = task.ownerSessionId;
		task.claimedFrom = from;
		task.claimedAt = now;
		task.ownerSessionId = sessionId;
		task.ownerSessionName = sessionName;
		task.updatedAt = now;

		// recurring 跳过逾期周期：补跑对“现在是什么状态”没有意义。
		// once 保持逾期，交给下一次 tick 立即执行——待办被拖晚了仍然要办。
		if (task.kind === "recurring" && task.nextRunAt <= now) {
			if (task.cronExpression) {
				const next = computeNextCronRunAt(task.cronExpression, now + 1_000);
				if (next) task.nextRunAt = next;
			} else {
				const intervalMs = task.intervalMs ?? DEFAULT_LOOP_INTERVAL;
				let next = task.nextRunAt;
				while (next <= now) next += intervalMs;
				task.nextRunAt = next;
			}
			task.pending = false;
		}

		return from;
	}
}
