import * as fs from "node:fs";
import * as path from "node:path";
import type { ScheduleTask } from "./types";

export interface SchedulerStore {
	version: 1;
	tasks: ScheduleTask[];
}

export const STORE_VERSION = 1;

/** 墓碑保留时长。删除靠墓碑跨进程传播，超过此时长后彻底丢弃。 */
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 读取存储文件。文件缺失或损坏时返回 undefined，调用方按“空库”处理，
 * 不要因为一次解析失败就清空用户的磁盘数据。
 */
export function readStore(filePath: string): SchedulerStore | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as SchedulerStore;
		const list = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
		return {
			version: STORE_VERSION,
			tasks: list.filter((task) => task && typeof task.id === "string" && typeof task.prompt === "string"),
		};
	} catch {
		return undefined;
	}
}

/**
 * 原子写入存储文件。
 * 临时文件带 pid 后缀：多个 pi 进程同时写盘时，固定的 `.tmp` 名会互相覆盖。
 */
export function writeStore(filePath: string, tasks: ScheduleTask[]): boolean {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const store: SchedulerStore = { version: STORE_VERSION, tasks };
		const tempPath = `${filePath}.${process.pid}.tmp`;
		fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf-8");
		fs.renameSync(tempPath, filePath);
		return true;
	} catch {
		return false;
	}
}

/** 拿任务的时间戳版本号；历史数据没有该字段时按 0 处理。 */
export function taskStamp(task: ScheduleTask): number {
	return task.updatedAt ?? 0;
}

/**
 * 按 id 合并两份任务列表，`updatedAt` 更大者胜出。
 * 这是修复“整表覆盖导致另一个窗口新建的任务被静默抹掉”的核心：
 * 写盘前先把磁盘上的现有内容读回来参与合并，而不是直接覆盖。
 */
export function mergeTasks(local: ScheduleTask[], remote: ScheduleTask[]): ScheduleTask[] {
	const merged = new Map<string, ScheduleTask>();
	for (const task of remote) merged.set(task.id, task);
	for (const task of local) {
		const existing = merged.get(task.id);
		// 相等时本地优先：本地是刚发生修改的那个。
		if (!existing || taskStamp(task) >= taskStamp(existing)) merged.set(task.id, task);
	}
	return Array.from(merged.values()).sort((a, b) => a.nextRunAt - b.nextRunAt);
}

export function isVisible(task: ScheduleTask): boolean {
	return !task.deletedAt;
}

export function pruneTombstones(tasks: ScheduleTask[], now: number): ScheduleTask[] {
	return tasks.filter((task) => !task.deletedAt || now - task.deletedAt < TOMBSTONE_TTL_MS);
}

/**
 * 归一化磁盘上读到的任务，顺便丢弃已过期的 recurring 任务。
 * `pending` 是纯内存态，落盘没有意义，读回时一律重置。
 */
export function normalizeTask(raw: ScheduleTask, now: number): ScheduleTask | undefined {
	if (raw.kind === "recurring" && raw.expiresAt && now >= raw.expiresAt) return undefined;
	return {
		...raw,
		enabled: raw.enabled ?? true,
		pending: false,
		runCount: raw.runCount ?? 0,
	};
}
