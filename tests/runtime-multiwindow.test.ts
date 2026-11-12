import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SchedulerRuntime } from "../src/runtime";
import { readStore } from "../src/store";

interface FakeSession {
	id: string;
	name?: string;
}

interface Harness {
	runtime: SchedulerRuntime;
	sent: string[];
	status: string[];
}

/**
 * 构造一个最小运行时：只实现调度路径真正用到的那几个接口。
 * 这里的重点是让两个 runtime 指向同一个 cwd，复现“两个 pi 窗口打开同一目录”。
 */
function makeRuntime(cwd: string, session: FakeSession): Harness {
	const sent: string[] = [];
	const status: string[] = [];

	const pi = {
		sendUserMessage: (text: string) => {
			sent.push(text);
		},
		sendMessage: () => {},
	} as never;

	const runtime = new SchedulerRuntime(pi);

	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				if (value !== undefined) status.push(value);
			},
			notify: () => {},
		},
		sessionManager: {
			getSessionId: () => session.id,
			getSessionName: () => session.name,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as never;

	runtime.setRuntimeContext(ctx);
	return { runtime, sent, status };
}

function tempCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-rt-"));
}

function isLeader(harness: Harness): boolean {
	const lease = (harness.runtime as unknown as { lease?: { isLeader(): boolean } }).lease;
	return lease?.isLeader() ?? false;
}

test("only one window dispatches when two share the same cwd", async () => {
	const cwd = tempCwd();
	const a = makeRuntime(cwd, { id: "sess-a" });
	const b = makeRuntime(cwd, { id: "sess-b" });

	// 未到期的任务：两个窗口都会 tick，但都不能提前执行
	a.runtime.addOneShotTask("check build", 60_000);

	await a.runtime.tickScheduler();
	await b.runtime.tickScheduler();

	assert.equal(a.sent.length, 0);
	assert.equal(b.sent.length, 0);
	assert.equal(isLeader(a), true);
	assert.equal(isLeader(b), false);
});

test("an expired task fires exactly once across two windows", async () => {
	const cwd = tempCwd();
	const a = makeRuntime(cwd, { id: "sess-a" });
	const b = makeRuntime(cwd, { id: "sess-b" });

	// 立刻到期
	a.runtime.addOneShotTask("deploy check", 0);

	await a.runtime.tickScheduler();
	await b.runtime.tickScheduler();
	await b.runtime.tickScheduler();

	assert.equal(a.sent.length, 1);
	assert.equal(b.sent.length, 0);
	assert.equal(a.sent[0], "deploy check");
});

test("the takeover window labels a task created by another session", async () => {
	const cwd = tempCwd();
	// 窗口 A 创建任务后就没再 tick，相当于关掉了
	const a = makeRuntime(cwd, { id: "sess-a", name: "VPN check" });
	a.runtime.addOneShotTask("query carbon api", 0);

	const b = makeRuntime(cwd, { id: "sess-b" });
	await b.runtime.tickScheduler();

	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0], /^⏰ \[taken over\]/);
	assert.match(b.sent[0], /VPN check/);
	assert.match(b.sent[0], /query carbon api$/);
});

test("warning-free dispatch when the owner runs its own task", async () => {
	const cwd = tempCwd();
	const a = makeRuntime(cwd, { id: "sess-a", name: "mine" });
	a.runtime.addOneShotTask("local task", 0);

	await a.runtime.tickScheduler();

	assert.equal(a.sent.length, 1);
	assert.equal(a.sent[0], "local task");
});

test("two windows creating tasks at the same time do not erase each other", async () => {
	const cwd = tempCwd();
	// 先让 A 落一条
	const a = makeRuntime(cwd, { id: "sess-a" });
	a.runtime.addOneShotTask("from a", 60_000);

	// B 的内存快照里还没有这条任务（尚未 tick 同步），直接新建
	const b = makeRuntime(cwd, { id: "sess-b" });
	b.runtime.addOneShotTask("from b", 60_000);

	const store = readStore(path.join(cwd, ".pi", "scheduler.json"));
	assert.ok(store);
	assert.deepEqual(store.tasks.map((t) => t.prompt).sort(), ["from a", "from b"]);
});

test("claim moves ownership and takes over the execution lease", async () => {
	const cwd = tempCwd();
	const a = makeRuntime(cwd, { id: "sess-a" });
	const task = a.runtime.addOneShotTask("handover", 60_000);

	await a.runtime.tickScheduler();
	assert.equal(isLeader(a), true);

	const b = makeRuntime(cwd, { id: "sess-b" });
	await b.runtime.tickScheduler();
	assert.equal(isLeader(b), false);

	const result = b.runtime.claimTask(task.id, "sess-b");
	assert.equal(result.ok, true);
	assert.equal(result.from, "sess-a");
	assert.equal(isLeader(b), true);

	// 原窗口下一次 tick 时发现锁已易主，退为观察者
	await a.runtime.tickScheduler();
	assert.equal(isLeader(a), false);
});

test("claim skips overdue recurring cycles instead of backfilling", async () => {
	const cwd = tempCwd();
	const a = makeRuntime(cwd, { id: "sess-a" });
	const task = a.runtime.addRecurringIntervalTask("poll ci", 5 * 60_000);

	// 模拟任务已经逾期很久
	const stored = (a.runtime as unknown as { tasks: Map<string, { nextRunAt: number }> }).tasks.get(task.id);
	assert.ok(stored);
	stored.nextRunAt = Date.now() - 60 * 60_000;

	a.runtime.claimTask(task.id, "sess-b");

	const claimed = a.runtime.getTask(task.id);
	assert.ok(claimed);
	assert.ok(claimed.nextRunAt > Date.now(), "recurring nextRunAt should be rescheduled into the future");
});

test("status bar reports other-session tasks separately", async () => {
	const cwd = tempCwd();
	const a = makeRuntime(cwd, { id: "sess-a" });
	a.runtime.addOneShotTask("foreign", 60_000);

	// B 在 A 落盘之后构造，能读到任务
	const b = makeRuntime(cwd, { id: "sess-b" });
	await b.runtime.tickScheduler();

	const last = b.status.at(-1);
	assert.ok(last);
	assert.match(last, /other session/);
});

/** 写入一个没有 ownerSessionId 的历史任务，模拟升级前的数据 */
function seedLegacyTask(cwd: string): void {
	const dir = path.join(cwd, ".pi");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "scheduler.json"),
		JSON.stringify({
			version: 1,
			tasks: [
				{
					id: "legacy01",
					prompt: "legacy reminder",
					kind: "once",
					enabled: true,
					createdAt: Date.now() - 60_000,
					nextRunAt: Date.now() - 1_000,
					jitterMs: 0,
					runCount: 0,
					pending: false,
				},
			],
		}),
		"utf-8",
	);
}

test("a legacy task without an owner is announced as unowned when it fires", async () => {
	const cwd = tempCwd();
	seedLegacyTask(cwd);

	const a = makeRuntime(cwd, { id: "sess-a" });
	await a.runtime.tickScheduler();

	assert.equal(a.sent.length, 1);
	assert.match(a.sent[0], /\[unowned task\]/);
	assert.match(a.sent[0], /\/schedule claim legacy01/);
});

test("a legacy task shows up as pending-claim instead of owned", async () => {
	const cwd = tempCwd();
	seedLegacyTask(cwd);

	const a = makeRuntime(cwd, { id: "sess-a" });
	// 构造时已经加载过任务，这里只刷新UI文案
	a.runtime.updateStatus();

	const last = a.status.at(-1);
	assert.ok(last);
	assert.match(last, /to claim/);
});
