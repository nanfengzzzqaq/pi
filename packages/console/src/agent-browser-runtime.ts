/**
 * Electron 内置智能体浏览器与 Pi 会话之间的窄接口。
 *
 * Web 开发模式不会注册运行时，因此浏览器能力不会被挂载；Electron 主进程
 * 在启动后注册实现。这里不依赖 electron，使后端和测试仍可单独运行。
 */

export interface AgentBrowserState {
	open: boolean;
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	status: string;
	downloadPath?: string;
}

export interface AgentBrowserTarget {
	ref?: string;
	selector?: string;
	text?: string;
}

export interface AgentBrowserRuntime {
	setDownloadDirectory(path: string): void;
	open(url?: string): Promise<AgentBrowserState>;
	hide(): AgentBrowserState;
	state(): AgentBrowserState;
	navigate(url: string): Promise<AgentBrowserState>;
	back(): Promise<AgentBrowserState>;
	forward(): Promise<AgentBrowserState>;
	reload(): Promise<AgentBrowserState>;
	snapshot(maxChars: number): Promise<string>;
	click(target: AgentBrowserTarget): Promise<string>;
	type(target: AgentBrowserTarget, value: string, submit: boolean): Promise<string>;
	scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<string>;
	extract(selector: string | undefined, maxChars: number): Promise<string>;
	screenshot(path: string): Promise<string>;
	wait(milliseconds: number, text?: string): Promise<string>;
}

let runtime: AgentBrowserRuntime | null = null;

export function registerAgentBrowserRuntime(value: AgentBrowserRuntime): void {
	runtime = value;
}

export function isAgentBrowserRuntimeAvailable(): boolean {
	return runtime !== null;
}

export function getAgentBrowserRuntime(): AgentBrowserRuntime {
	if (!runtime) throw new Error("客户端内置浏览器只在 Windows 桌面版中可用");
	return runtime;
}
