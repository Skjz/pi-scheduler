import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { mergeTasks, pruneTombstones, readStore, TOMBSTONE_TTL_MS, writeStore } from "../src/store";
import type { ScheduleTask } from "../src/types";

function task(overrides: Partial<ScheduleTask> & { id: string }): ScheduleTask {
	return {
		prompt: "check build",
		kind: "once",
		enabled: true,
		createdAt: 1_000,
		nextRunAt: 2_000,
		jitterMs: 0,
		runCount: 0,
		pending: false,
		...overrides,
	};
}

test("mergeTasks keeps the version with the newer updatedAt", () => {
	const local = [task({ id: "a", prompt: "local", updatedAt: 200 })];
	const disk = [task({ id: "a", prompt: "disk", updatedAt: 100 })];

	const merged = mergeTasks(local, disk);

	assert.equal(merged.length, 1);
	assert.equal(merged[0].prompt, "local");
});

test("mergeTasks picks the disk version when it is newer", () => {
	const local = [task({ id: "a", prompt: "local", updatedAt: 100 })];
	const disk = [task({ id: "a", prompt: "disk", updatedAt: 200 })];

	const merged = mergeTasks(local, disk);

	assert.equal(merged.length, 1);
	assert.equal(merged[0].prompt, "disk");
});

test("mergeTasks keeps tasks that exist on only one side", () => {
	const local = [task({ id: "local-only", updatedAt: 100 })];
	const disk = [task({ id: "disk-only", updatedAt: 100 })];

	const merged = mergeTasks(local, disk);

	assert.deepEqual(
		merged.map((t) => t.id).sort(),
		["disk-only", "local-only"],
	);
});

test("a tombstone wins over a stale live copy", () => {
	// 窗口 A 删除了任务（墓碑 updatedAt 更新），窗口 B 内存里还是旧数据
	const local = [task({ id: "a", updatedAt: 100 })];
	const disk = [task({ id: "a", updatedAt: 200, deletedAt: 200 })];

	const merged = mergeTasks(local, disk);

	assert.equal(merged.length, 1);
	assert.equal(merged[0].deletedAt, 200);
});

test("pruneTombstones drops tombstones older than the TTL", () => {
	const now = 10_000_000_000;
	const tasks = [
		task({ id: "fresh", deletedAt: now - 1_000 }),
		task({ id: "stale", deletedAt: now - TOMBSTONE_TTL_MS - 1_000 }),
		task({ id: "alive" }),
	];

	const pruned = pruneTombstones(tasks, now);

	assert.deepEqual(
		pruned.map((t) => t.id).sort(),
		["alive", "fresh"],
	);
});

test("writeStore and readStore round-trip tasks", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-store-"));
	const filePath = path.join(dir, ".pi", "scheduler.json");
	const tasks = [task({ id: "a", updatedAt: 1 }), task({ id: "b", updatedAt: 2 })];

	assert.equal(writeStore(filePath, tasks), true);
	const store = readStore(filePath);

	assert.ok(store);
	assert.deepEqual(
		store.tasks.map((t) => t.id),
		["a", "b"],
	);
});

test("readStore returns undefined for a corrupt file instead of throwing", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-store-"));
	const filePath = path.join(dir, "scheduler.json");
	fs.writeFileSync(filePath, "{ broken", "utf-8");

	assert.equal(readStore(filePath), undefined);
});
