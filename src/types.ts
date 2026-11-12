export type TaskKind = "recurring" | "once";

export type TaskStatus = "pending" | "success" | "error";

export interface ScheduleTask {
	id: string;
	prompt: string;
	kind: TaskKind;
	enabled: boolean;
	createdAt: number;
	nextRunAt: number;
	intervalMs?: number;
	cronExpression?: string;
	expiresAt?: number;
	jitterMs: number;
	lastRunAt?: number;
	lastStatus?: TaskStatus;
	runCount: number;
	pending: boolean;
	/** 创建该任务的会话。缺失表示历史遗留任务，尚无人认领。 */
	ownerSessionId?: string;
	/** 所有者会话的显示名，仅用于提示文案。 */
	ownerSessionName?: string;
	/** 认领审计：被认领前的所有者会话。 */
	claimedFrom?: string;
	claimedAt?: number;
	/** 最后修改时间，多进程合并时用于判定新旧。 */
	updatedAt?: number;
	/** 墓碑：软删除时间，用于把删除操作传播给其它窗口。 */
	deletedAt?: number;
}

export type RecurringSpec =
	| { mode: "interval"; durationMs: number; note?: string }
	| { mode: "cron"; cronExpression: string; note?: string };

export interface ParseResult {
	prompt: string;
	recurring: RecurringSpec;
}

export interface ReminderParseResult {
	prompt: string;
	durationMs: number;
	note?: string;
}

export type SchedulePromptAddPlan =
	| { kind: "once"; durationMs: number; note?: string }
	| { kind: "recurring"; mode: "interval"; durationMs: number; note?: string }
	| { kind: "recurring"; mode: "cron"; cronExpression: string; note?: string };
