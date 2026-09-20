import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function sessionThinkingOptions(
	session: Pick<AgentSession, "model" | "thinkingLevel" | "getAvailableThinkingLevels" | "setThinkingLevel">,
) {
	const model = session.model;
	const available = session.getAvailableThinkingLevels();
	const map = model?.thinkingLevelMap;
	const binary =
		model?.compat && "thinkingFormat" in model.compat && model.compat.thinkingFormat === "qwen-chat-template";
	const enabledLevel = available.includes("high") ? "high" : available.find((level) => level !== "off");
	// Several catalog entries map aliases to one wire value. Prefer its actual name.
	const levels = available.filter((level, index) => {
		if (binary) return level === "off" || level === enabledLevel;
		const wire = map?.[level];
		if (typeof wire !== "string") return true;
		const canonical = available.find((candidate) => candidate === wire && map?.[candidate] === wire);
		return canonical
			? level === canonical
			: !available.slice(0, index).some((candidate) => map?.[candidate] === wire);
	});
	if (!levels.includes(session.thinkingLevel)) {
		const equivalent = levels.find((level) => map?.[level] === map?.[session.thinkingLevel]);
		session.setThinkingLevel(equivalent ?? levels.at(-1) ?? "off");
	}
	const unknown =
		model?.reasoning &&
		model.provider.startsWith("pi-console-custom-") &&
		!binary &&
		levels.length === 1 &&
		levels[0] === "off";
	const thinkingNote = unknown
		? "服务未公布推理档位，使用服务端默认值；可在模型设置中填写已确认的档位。"
		: binary
			? "此模型通过开关启用思考，没有独立的强度档位。"
			: "仅显示当前模型支持的档位；最高档已标注。";
	return {
		thinkingLevel: session.thinkingLevel,
		availableThinkingLevels: levels,
		thinkingChoices: levels.map((value) => ({
			value,
			label: unknown
				? "服务端默认"
				: binary
					? value === "off"
						? "关闭思考"
						: "开启思考"
					: value === "off"
						? "关闭思考"
						: `${typeof map?.[value] === "string" ? map[value] : value}${value === levels.at(-1) ? " · 最高" : ""}`,
		})),
		thinkingNote,
	};
}
