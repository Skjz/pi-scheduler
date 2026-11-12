import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LeaseRecord {
	version: 1;
	pid: number;
	/** 同一进程内的实例标识，用于区分“切会话”和“扩展被重复加载” */
	instanceId: string;
	sessionId: string;
	heartbeatAt: number;
	startedAt: number;
}

export interface LeaseOptions {
	filePath: string;
	sessionId: string;
	/** 便于测试注入；默认取当前进程 pid */
	currentPid?: number;
	/** 便于测试注入；默认每个实例自动生成 */
	instanceId?: string;
	/** 便于测试注入假时钟 */
	now?: () => number;
	/** 心跳写入间隔，默认 2s */
	heartbeatMs?: number;
	/** 超过该时长未更新心跳即视为失效，默认 8s */
	timeoutMs?: number;
	isProcessAlive?: (pid: number) => boolean;
}

export type LeaseState = "leader" | "follower";

export const DEFAULT_HEARTBEAT_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 8000;

/** `kill(pid, 0)` 不发送信号，只探测存在性；EPERM 说明进程在但不属于当前用户。 */
export function defaultIsProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * 单文件租约。
 *
 * 定时任务的存储按工作目录共享，多个 pi 进程读到的是同一批任务。
 * 如果每个进程各自 tick 并 dispatch，同一条提醒会被触发多次。
 * 这里用一把带心跳的文件锁保证任意时刻只有一个进程执行（leader），
 * 其余进程降级为只读观察者。
 *
 * 抢占条件取“心跳超时”或“进程已死”任意一条成立即可：
 * 只看 pid 会被 pid 复用骗过，只看时间戳又无法在进程崩溃后立即接手。
 */
export class LeaseManager {
	private readonly filePath: string;
	private readonly currentPid: number;
	private readonly instanceId: string;
	private readonly now: () => number;
	private readonly heartbeatMs: number;
	private readonly timeoutMs: number;
	private readonly isProcessAlive: (pid: number) => boolean;
	private sessionId: string;
	private leader = false;
	private lastHeartbeatWrite = 0;

	constructor(options: LeaseOptions) {
		this.filePath = options.filePath;
		this.currentPid = options.currentPid ?? process.pid;
		this.instanceId = options.instanceId ?? randomUUID();
		this.now = options.now ?? (() => Date.now());
		this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
		this.sessionId = options.sessionId;
	}

	setSessionId(sessionId: string) {
		this.sessionId = sessionId;
	}

	isLeader(): boolean {
		return this.leader;
	}

	read(): LeaseRecord | undefined {
		try {
			if (!fs.existsSync(this.filePath)) return undefined;
			const raw = fs.readFileSync(this.filePath, "utf-8");
			const parsed = JSON.parse(raw) as LeaseRecord;
			if (typeof parsed?.pid !== "number") return undefined;
			return parsed;
		} catch {
			return undefined;
		}
	}

	/** 尝试成为或保持 leader。每个 tick 调用一次。 */
	acquire(): LeaseState {
		const now = this.now();
		const current = this.read();

		if (!current) {
			this.write(now);
			this.leader = true;
			return "leader";
		}

		// 同一个运行实例：包括同一进程内 /new 切了会话的情况，不能让出执行权。
		// 但 pid 相同、instanceId 不同，说明是同一进程里的另一个 runtime（例如扩展被加载两次），
		// 那属于真正的竞争者，必须走下面的心跳/存活判断。
		const sameRuntime = current.pid === this.currentPid && (current.instanceId === this.instanceId || !current.instanceId);
		if (sameRuntime) {
			this.leader = true;
			if (current.sessionId !== this.sessionId) {
				this.write(now);
			} else if (now - this.lastHeartbeatWrite >= this.heartbeatMs) {
				this.write(now);
			}
			return "leader";
		}

		const expired = now - current.heartbeatAt > this.timeoutMs;
		const dead = !this.isProcessAlive(current.pid);
		if (expired || dead) {
			this.write(now);
			this.leader = true;
			return "leader";
		}

		this.leader = false;
		return "follower";
	}

	/** 认领任务时强制夺取执行权，用于让原窗口立即停手。 */
	forceAcquire() {
		const now = this.now();
		this.write(now);
		this.leader = true;
	}

	/** 正常退出时主动让位，让其它窗口无需等待心跳超时。 */
	release() {
		if (!this.leader) return;
		const current = this.read();
		const sameRuntime = current && current.pid === this.currentPid && (current.instanceId === this.instanceId || !current.instanceId);
		if (sameRuntime) {
			try {
				fs.unlinkSync(this.filePath);
			} catch {
				// 忽略：文件可能已被别的进程清掉
			}
		}
		this.leader = false;
	}

	private write(now: number) {
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			const record: LeaseRecord = {
				version: 1,
				pid: this.currentPid,
				instanceId: this.instanceId,
				sessionId: this.sessionId,
				heartbeatAt: now,
				startedAt: now,
			};
			// 带 pid 的临时文件名，避免多进程并发写同一个 `.tmp`
			const tempPath = `${this.filePath}.${this.currentPid}.tmp`;
			fs.writeFileSync(tempPath, JSON.stringify(record), "utf-8");
			fs.renameSync(tempPath, this.filePath);
			this.lastHeartbeatWrite = now;
		} catch {
			// 锁文件写失败（只读磁盘等）：保持上一状态，不抛异常打断会话
		}
	}
}
