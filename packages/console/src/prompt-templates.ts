/**
 * 提示词模板库 — 空对话状态下的一键模板卡片。
 *
 * 模板保存在 <DATA_DIR>/prompt-templates.json，所有浏览器客户端共享；
 * 首次运行写入内置默认模板，用户可编辑、删除、新增自己的模板。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PromptTemplate {
	id: string;
	icon: string;
	title: string;
	description: string;
	text: string;
	builtin: boolean;
}

const MAX_TEMPLATES = 60;
const MAX_TEXT_CHARS = 8000;

/** 内置默认模板（改编自 pi-web-ui 社区项目的模板思路，按本控制台语境调整）。 */
const BUILTIN_TEMPLATES: PromptTemplate[] = [
	{
		id: "builtin-repo-init",
		icon: "🛠",
		title: "仓库初始化",
		description: "让仓库了解它的构建与约定",
		text: "请阅读这个仓库的构建脚本、目录结构和贡献文档，总结：1) 如何安装依赖并构建；2) 如何运行测试；3) 项目的主要模块和分层；4) 有哪些必须遵守的约定。把结论写成简明的入门笔记。",
		builtin: true,
	},
	{
		id: "builtin-skill-nav",
		icon: "🧭",
		title: "技能导航",
		description: "告诉我该用哪个流程",
		text: "我想完成下面的任务，请先查看可用的技能和工具目录，告诉我应该按什么流程做、每一步用什么能力，先给计划再动手：\n\n（在这里描述你的任务）",
		builtin: true,
	},
	{
		id: "builtin-requirement",
		icon: "🗣",
		title: "需求拷问",
		description: "边盘问需求边记录决策",
		text: "我要做一个东西，需求还很模糊。请你像资深产品经理一样逐条盘问我的需求：先问最关键的 3 个问题，等我回答后再继续追问，边问边把已确认的决策整理成需求清单。我的想法是：\n\n（在这里描述你的想法）",
		builtin: true,
	},
	{
		id: "builtin-spec",
		icon: "📝",
		title: "转规格说明",
		description: "把讨论结果整理成规格书",
		text: "把我们刚才讨论的方案整理成一份规格说明文档：目标、范围、功能清单（按优先级）、验收标准、风险与待定项。用 Markdown 输出，保存为 SPEC.md。",
		builtin: true,
	},
	{
		id: "builtin-tasks",
		icon: "🎫",
		title: "拆工单",
		description: "把规格拆成可构建的小任务",
		text: "把 SPEC.md（或我们讨论的需求）拆成可独立构建的小任务：每个任务有明确的完成标准、涉及文件、预估规模（S/M/L）和依赖顺序。输出成表格。",
		builtin: true,
	},
	{
		id: "builtin-implement",
		icon: "🏗",
		title: "规格落地",
		description: "按规格测试优先实现",
		text: "按规格实现下面这个任务：先写测试（或验证方式），再实现，最后运行验证并汇报结果。任务：\n\n（在这里粘贴工单或任务描述）",
		builtin: true,
	},
	{
		id: "builtin-review",
		icon: "🧹",
		title: "代码审查",
		description: "对照规格与标准审查 diff",
		text: "请审查当前工作区的改动（git diff）：正确性、边界情况、可读性、与现有约定的一致性。按严重程度列出问题，并给出具体修改建议。",
		builtin: true,
	},
	{
		id: "builtin-research",
		icon: "📚",
		title: "有据调研",
		description: "读一手来源给出带引用的答案",
		text: "请调研下面的问题：优先阅读本地仓库/文档等一手来源，结论标注出处；不确定的地方明确说不确定。问题：\n\n（在这里写你的问题）",
		builtin: true,
	},
	{
		id: "builtin-arch",
		icon: "🏛",
		title: "架构体检",
		description: "找出值得重构的模块（报告）",
		text: "对当前仓库做一次架构体检：模块职责是否清晰、依赖方向是否合理、有没有明显的重复和耦合热点。输出一份报告，指出最值得重构的 3 个模块和理由，不要动手改代码。",
		builtin: true,
	},
	{
		id: "builtin-debug",
		icon: "🐛",
		title: "系统化排错",
		description: "从可复现的失败开始诊断",
		text: "帮我系统化排查一个 bug。先复现（给出最小复现步骤），再定位（列出假设并逐一验证），最后给出根因和修复方案。现象：\n\n（在这里描述错误现象）",
		builtin: true,
	},
	{
		id: "builtin-prototype",
		icon: "🔬",
		title: "快速原型",
		description: "用一次性代码验证设计假设",
		text: "我想验证一个设计假设。请用最小的一次性代码写个原型验证它（不用考虑工程质量），告诉我结论和证据。假设：\n\n（在这里写你的假设）",
		builtin: true,
	},
	{
		id: "builtin-doc",
		icon: "📖",
		title: "补文档",
		description: "给模块补上能看懂的说明",
		text: "请给当前仓库补文档：README（如果缺失或过时）、关键模块的职责说明、常见操作的 how-to。先读代码再写，不要编造。",
		builtin: true,
	},
];

function coerceTemplate(value: unknown): PromptTemplate | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || typeof v.title !== "string" || typeof v.text !== "string") return null;
	if (v.id.length > 80 || v.title.length > 80) return null;
	return {
		id: v.id,
		icon: typeof v.icon === "string" ? v.icon.slice(0, 8) : "📄",
		title: v.title.slice(0, 80),
		description: typeof v.description === "string" ? v.description.slice(0, 160) : "",
		text: v.text.slice(0, MAX_TEXT_CHARS),
		builtin: v.builtin === true,
	};
}

export class PromptTemplateStore {
	private readonly file: string;
	private cache: PromptTemplate[] | null = null;

	constructor(dataDir: string) {
		this.file = join(dataDir, "prompt-templates.json");
	}

	list(): PromptTemplate[] {
		if (this.cache) return this.cache;
		if (!existsSync(this.file)) {
			this.cache = [...BUILTIN_TEMPLATES];
			this.persist();
			return this.cache;
		}
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
			const items = Array.isArray(raw) ? raw.map(coerceTemplate).filter((t): t is PromptTemplate => t !== null) : [];
			this.cache = items.length > 0 ? items : [...BUILTIN_TEMPLATES];
		} catch {
			this.cache = [...BUILTIN_TEMPLATES];
		}
		return this.cache;
	}

	/** 全量保存（新增/编辑/删除都由前端提交完整列表）。 */
	save(input: unknown): PromptTemplate[] {
		if (!Array.isArray(input)) throw new Error("模板列表需为数组");
		const items = input.map(coerceTemplate).filter((t): t is PromptTemplate => t !== null);
		if (items.length === 0) throw new Error("至少保留一个模板");
		if (items.length > MAX_TEMPLATES) throw new Error(`模板最多 ${MAX_TEMPLATES} 个`);
		const ids = new Set<string>();
		for (const item of items) {
			if (ids.has(item.id)) throw new Error(`模板 id 重复：${item.id}`);
			ids.add(item.id);
		}
		this.cache = items;
		this.persist();
		return items;
	}

	private persist(): void {
		writeFileSync(this.file, `${JSON.stringify(this.cache ?? [], null, "\t")}\n`, "utf8");
	}
}
