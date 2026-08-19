/**
 * OfficeCLI 官方技能目录与安装器。
 *
 * 安装位置按“工具 → 技能”分组：
 *   <agentDir>/skills/officecli/<catalogId>/SKILL.md
 * Pi 会递归发现这些标准技能；界面也用同一份目录展示归属关系。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadOfficialSkill } from "./officecli.ts";

export type OfficeCliSkillCategory = "Word" | "PowerPoint" | "Excel";

export interface OfficeCliSkillDefinition {
	id: string;
	internalName: string;
	displayName: string;
	description: string;
	category: OfficeCliSkillCategory;
	formats: string[];
	requires: string[];
}

export interface OfficeCliSkillCatalogItem extends OfficeCliSkillDefinition {
	toolId: "officecli";
	installed: boolean;
	installPath: string;
}

export const OFFICECLI_SKILLS: readonly OfficeCliSkillDefinition[] = [
	{
		id: "word",
		internalName: "officecli-docx",
		displayName: "Word 文档",
		description: "创建、读取、编辑和检查 Word 文档，覆盖样式、目录、页眉页脚、批注与修订。",
		category: "Word",
		formats: [".docx"],
		requires: [],
	},
	{
		id: "academic-paper",
		internalName: "officecli-academic-paper",
		displayName: "学术论文",
		description: "制作带引用格式、公式编号、交叉引用、脚注和参考文献的学术 Word 文档。",
		category: "Word",
		formats: [".docx"],
		requires: ["word"],
	},
	{
		id: "pptx",
		internalName: "officecli-pptx",
		displayName: "PowerPoint 演示文稿",
		description: "创建、读取、编辑和检查演示文稿，覆盖版式、图表、备注、批注与模板。",
		category: "PowerPoint",
		formats: [".pptx"],
		requires: [],
	},
	{
		id: "pitch-deck",
		internalName: "officecli-pitch-deck",
		displayName: "融资路演",
		description: "制作种子轮、A/B/C 轮等融资场景的投资人路演演示文稿。",
		category: "PowerPoint",
		formats: [".pptx"],
		requires: ["pptx"],
	},
	{
		id: "morph-ppt",
		internalName: "morph-ppt",
		displayName: "动态变形演示",
		description: "制作带平滑跨页变形、连续移动、缩放与旋转效果的演示文稿。",
		category: "PowerPoint",
		formats: [".pptx"],
		requires: ["pptx"],
	},
	{
		id: "morph-ppt-3d",
		internalName: "morph-ppt-3d",
		displayName: "三维动态演示",
		description: "在动态变形演示中加入三维模型、镜头运动与三维内容布局。",
		category: "PowerPoint",
		formats: [".pptx", ".glb"],
		requires: ["pptx", "morph-ppt"],
	},
	{
		id: "excel",
		internalName: "officecli-xlsx",
		displayName: "Excel 工作簿",
		description: "创建、读取、编辑和检查工作簿，覆盖公式、图表、透视表、模板与数据导入。",
		category: "Excel",
		formats: [".xlsx", ".csv", ".tsv"],
		requires: [],
	},
	{
		id: "financial-model",
		internalName: "officecli-financial-model",
		displayName: "财务模型",
		description: "制作三表、现金流折现、杠杆收购、敏感性分析和经营预测等公式驱动模型。",
		category: "Excel",
		formats: [".xlsx"],
		requires: ["excel"],
	},
	{
		id: "data-dashboard",
		internalName: "officecli-data-dashboard",
		displayName: "数据看板",
		description: "从表格数据制作带指标卡、图表、迷你图和条件格式的 Excel 看板。",
		category: "Excel",
		formats: [".xlsx", ".csv", ".tsv"],
		requires: ["excel"],
	},
];

function definitionById(id: string): OfficeCliSkillDefinition | undefined {
	return OFFICECLI_SKILLS.find((skill) => skill.id === id);
}

export function officeCliSkillPath(agentDir: string, id: string): string {
	return join(agentDir, "skills", "officecli", id, "SKILL.md");
}

export function listOfficeCliSkills(agentDir: string): OfficeCliSkillCatalogItem[] {
	return OFFICECLI_SKILLS.map((skill) => ({
		...skill,
		toolId: "officecli" as const,
		installed: existsSync(officeCliSkillPath(agentDir, skill.id)),
		installPath: officeCliSkillPath(agentDir, skill.id),
	}));
}

/** 依赖优先、目标最后；用于场景技能自动补齐基础技能。 */
export function officeCliSkillInstallOrder(id: string): OfficeCliSkillDefinition[] {
	const ordered: OfficeCliSkillDefinition[] = [];
	const visited = new Set<string>();
	const visit = (skillId: string): void => {
		if (visited.has(skillId)) return;
		const skill = definitionById(skillId);
		if (!skill) throw new Error(`未知的 OfficeCLI 技能：${skillId}`);
		visited.add(skillId);
		for (const dependency of skill.requires) visit(dependency);
		ordered.push(skill);
	};
	visit(id);
	return ordered;
}

function replaceFrontmatterField(content: string, field: string, value: string): string {
	const expression = new RegExp(`^${field}:.*$`, "m");
	if (!expression.test(content)) throw new Error(`官方技能缺少 ${field} 字段`);
	return content.replace(expression, `${field}: ${JSON.stringify(value)}`);
}

/**
 * 保留 OfficeCLI 官方正文，只缩短模型常驻的 description，并增加 Windows 执行约束。
 * 这样完整技能仍按需读取，日常对话只承担一行中文摘要。
 */
export function adaptOfficialSkill(content: string, skill: OfficeCliSkillDefinition): string {
	const nameMatch = content.match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m);
	if (nameMatch?.[1]?.trim() !== skill.internalName) {
		throw new Error(`官方技能名称不匹配：期望 ${skill.internalName}，实际 ${nameMatch?.[1]?.trim() ?? "缺失"}`);
	}
	let adapted = replaceFrontmatterField(content, "description", skill.description);
	// 官方场景技能按扁平目录引用基础技能；安装后位于同一 OfficeCLI 分组下，改成真实兄弟目录。
	for (const referencedSkill of OFFICECLI_SKILLS) {
		adapted = adapted.replaceAll(`skills/${referencedSkill.internalName}/`, `../${referencedSkill.id}/`);
	}
	const frontmatterEnd = adapted.indexOf("\n---", 4);
	if (frontmatterEnd < 0) throw new Error("官方技能 frontmatter 不完整");
	const insertAt = frontmatterEnd + 4;
	const windowsGuide = [
		"",
		"## Pi 控制台 Windows 适配",
		"",
		"- 当前客户端运行于 Windows x64，OfficeCLI 由工具管理器安装并加入当前客户端进程的 PATH，不修改系统 PATH。",
		'- Pi 的命令工具使用 PowerShell。把示例中的 `FILE="..."` 改为 `$FILE = "..."`；临时目录使用 `$env:TEMP`。',
		"- 不直接照抄仅适用于 bash 的 heredoc、`grep`、`sed`、`jq` 或 `/tmp` 写法；分别改用 PowerShell here-string、`Select-String`、`ConvertFrom-Json` 和 `$env:TEMP`。",
		"- `officecli` 命令名、参数、元素路径和属性名属于代码接口，保持原样。向用户汇报执行过程时使用中文，并在需要定位问题时附内部名。",
		"",
	].join("\n");
	adapted = `${adapted.slice(0, insertAt)}${windowsGuide}${adapted.slice(insertAt).replace(/^\r?\n/, "")}`;
	return adapted.endsWith("\n") ? adapted : `${adapted}\n`;
}

export async function installOfficeCliSkill(
	agentDir: string,
	id: string,
): Promise<Array<{ id: string; internalName: string; path: string }>> {
	const installed: Array<{ id: string; internalName: string; path: string }> = [];
	for (const skill of officeCliSkillInstallOrder(id)) {
		const path = officeCliSkillPath(agentDir, skill.id);
		if (existsSync(path)) continue;
		const official = await loadOfficialSkill(skill.id);
		const adapted = adaptOfficialSkill(official, skill);
		mkdirSync(join(agentDir, "skills", "officecli", skill.id), { recursive: true });
		writeFileSync(path, adapted, "utf8");
		installed.push({ id: skill.id, internalName: skill.internalName, path });
	}
	return installed;
}

export async function installAllOfficeCliSkills(
	agentDir: string,
): Promise<Array<{ id: string; internalName: string; path: string }>> {
	const installed: Array<{ id: string; internalName: string; path: string }> = [];
	for (const skill of OFFICECLI_SKILLS) {
		installed.push(...(await installOfficeCliSkill(agentDir, skill.id)));
	}
	return installed;
}

export function readInstalledOfficeCliSkill(agentDir: string, id: string): string | null {
	const path = officeCliSkillPath(agentDir, id);
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
