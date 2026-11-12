import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SchedulerRuntime } from "./runtime";

export function registerEvents(pi: ExtensionAPI, runtime: SchedulerRuntime) {
	// pi 1.5+ 把 session_switch / session_fork 合并进了 session_start
	// （用 event.reason 区分 startup | reload | new | resume | fork），
	// 因此只处理 session_start 即可覆盖新会话、恢复、分叉、重载全部情况。
	pi.on("session_start", async (_event, ctx) => {
		runtime.setRuntimeContext(ctx);
		runtime.startScheduler();
		runtime.updateStatus();
	});

	pi.on("session_tree", async (_event, ctx) => {
		runtime.setRuntimeContext(ctx);
		runtime.updateStatus();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runtime.setRuntimeContext(ctx);
		runtime.stopScheduler();
		runtime.clearStatus(ctx);
	});
}
