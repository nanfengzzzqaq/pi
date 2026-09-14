/**
 * 文件树实时刷新 — 服务端 fs.watch 监听当前浏览目录，改动事件经 SSE 推给前端。
 *
 * 全局只保留最近一个被监听的目录（文件面板是单实例视图），
 * 前端切换目录时重新连接即可换监听目标。
 */

import { type FSWatcher, watch } from "node:fs";
import type { ServerResponse } from "node:http";

interface WatchClient {
	response: ServerResponse;
}

let activeWatcher: FSWatcher | null = null;
let watchedPath: string | null = null;
const clients = new Set<WatchClient>();
let debounceTimer: NodeJS.Timeout | null = null;

function broadcast(event: string, data: unknown): void {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const client of clients) {
		try {
			client.response.write(payload);
		} catch {
			clients.delete(client);
		}
	}
}

function closeActiveWatcher(): void {
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = null;
	}
	if (activeWatcher) {
		try {
			activeWatcher.close();
		} catch {
			/* 已关闭 */
		}
		activeWatcher = null;
		watchedPath = null;
	}
}

/** 开始监听 directory 并把该客户端注册为事件接收方。 */
export function watchDirectory(directory: string, response: ServerResponse): void {
	const headers = {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	};
	response.writeHead(200, headers);
	const client: WatchClient = { response };
	clients.add(client);
	response.on("close", () => {
		clients.delete(client);
		if (clients.size === 0) closeActiveWatcher();
	});

	if (watchedPath !== directory) {
		closeActiveWatcher();
		try {
			// Windows 支持 recursive:false 的目录监听；这里监听目录自身的条目变化
			activeWatcher = watch(directory, { persistent: false }, () => {
				// 合并短时间内的连续改动，避免保存时触发多次重列
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					debounceTimer = null;
					broadcast("fs_change", { directory });
				}, 300);
			});
			watchedPath = directory;
		} catch {
			broadcast("fs_watch_error", { directory });
		}
	}
	broadcast("fs_watch_ready", { directory });
}
