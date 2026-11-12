import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { LeaseManager } from "../src/lease";

function lockPath(dir: string): string {
	return path.join(dir, "scheduler.lock");
}

function makeLease(options: {
	dir: string;
	sessionId: string;
	pid: number;
	now: () => number;
	isProcessAlive: (pid: number) => boolean;
}): LeaseManager {
	return new LeaseManager({
		filePath: lockPath(options.dir),
		sessionId: options.sessionId,
		currentPid: options.pid,
		now: options.now,
		isProcessAlive: options.isProcessAlive,
	});
}

test("acquire becomes leader when no lock file exists", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-lease-"));
	let now = 1_000_000;
	const lease = makeLease({ dir, sessionId: "sess-a", pid: 111, now: () => now, isProcessAlive: () => true });

	assert.equal(lease.acquire(), "leader");
	assert.equal(lease.isLeader(), true);
	assert.equal(lease.read()?.pid, 111);
});

test("a second live process stays follower", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-lease-"));
	let now = 1_000_000;
	const a = makeLease({ dir, sessionId: "sess-a", pid: 111, now: () => now, isProcessAlive: () => true });
	const b = makeLease({ dir, sessionId: "sess-b", pid: 222, now: () => now, isProcessAlive: () => true });

	assert.equal(a.acquire(), "leader");
	now += 1_000;
	assert.equal(b.acquire(), "follower");
	assert.equal(b.isLeader(), false);
});

test("a stale heartbeat lets another process take over", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-lease-"));
	let now = 1_000_000;
	const a = makeLease({ dir, sessionId: "sess-a", pid: 111, now: () => now, isProcessAlive: () => true });
	const b = makeLease({ dir, sessionId: "sess-b", pid: 222, now: () => now, isProcessAlive: () => true });

	assert.equal(a.acquire(), "leader");
	// 超过默认 8s 超时，且 a 之后再没续约
	now += 9_000;
	assert.equal(b.acquire(), "leader");
	assert.equal(b.read()?.pid, 222);
});

test("a dead holder is replaced without waiting for the timeout", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-lease-"));
	let now = 1_000_000;
	const a = makeLease({ dir, sessionId: "sess-a", pid: 111, now: () => now, isProcessAlive: () => true });
	const b = makeLease({ dir, sessionId: "sess-b", pid: 222, now: () => now, isProcessAlive: () => false });

	assert.equal(a.acquire(), "leader");
	now += 100; // 心跳还很新，但持有者已经死了
	assert.equal(b.acquire(), "leader");
});

test("switching sessions inside the same process keeps leadership", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-lease-"));
	let now = 1_000_000;
	const lease = makeLease({ dir, sessionId: "sess-old", pid: 111, now: () => now, isProcessAlive: () => true });
	assert.equal(lease.acquire(), "leader");

	// 真实路径：同 cwd 下 /new 只更新会话 id，runtime 实例不变
	lease.setSessionId("sess-new");
	now += 100;
	assert.equal(lease.acquire(), "leader");
	assert.equal(lease.read()?.sessionId, "sess-new");
});

test("two runtimes inside one process still compete for the lease", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-lease-"));
	let now = 1_000_000;
	// 同一 pid、不同 instanceId：模拟扩展被重复加载
	const first = makeLease({ dir, sessionId: "sess-a", pid: 111, now: () => now, isProcessAlive: () => true });
	const second = makeLease({ dir, sessionId: "sess-b", pid: 111, now: () => now, isProcessAlive: () => true });

	assert.equal(first.acquire(), "leader");
	now += 100;
	assert.equal(second.acquire(), "follower");
});

test("forceAcquire hands the lease over to the claiming process", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-lease-"));
	let now = 1_000_000;
	const a = makeLease({ dir, sessionId: "sess-a", pid: 111, now: () => now, isProcessAlive: () => true });
	const b = makeLease({ dir, sessionId: "sess-b", pid: 222, now: () => now, isProcessAlive: () => true });

	assert.equal(a.acquire(), "leader");
	now += 100;
	b.forceAcquire();
	assert.equal(b.isLeader(), true);

	// 原持有者下一次 tick 会发现锁已易主，退为观察者
	now += 100;
	assert.equal(a.acquire(), "follower");
});

test("release frees the lease immediately for other processes", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-lease-"));
	let now = 1_000_000;
	const a = makeLease({ dir, sessionId: "sess-a", pid: 111, now: () => now, isProcessAlive: () => true });
	const b = makeLease({ dir, sessionId: "sess-b", pid: 222, now: () => now, isProcessAlive: () => true });

	assert.equal(a.acquire(), "leader");
	a.release();
	now += 100;
	assert.equal(b.acquire(), "leader");
});

test("a corrupt lock file is treated as no lock", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-lease-"));
	fs.writeFileSync(lockPath(dir), "{not json", "utf-8");
	let now = 1_000_000;
	const a = makeLease({ dir, sessionId: "sess-a", pid: 111, now: () => now, isProcessAlive: () => true });

	assert.equal(a.acquire(), "leader");
	assert.equal(a.read()?.pid, 111);
});
