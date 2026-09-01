import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * 保留资源加载器发现的完整 Skill 集合，但只把本轮选中的条目交给 AgentSession。
 * AgentSession 在切换工具时会同步重建系统提示词，因此工具和 Skill 始终按同一轮生效。
 */
export class RoutedSkillResourceLoader extends DefaultResourceLoader {
	private activeSkillNames = new Set<string>();

	setActiveSkillNames(names: Iterable<string>): void {
		this.activeSkillNames = new Set(names);
	}

	getAllSkills(): ReturnType<DefaultResourceLoader["getSkills"]> {
		return super.getSkills();
	}

	override getSkills(): ReturnType<DefaultResourceLoader["getSkills"]> {
		const result = super.getSkills();
		return {
			...result,
			skills: result.skills.filter((skill) => this.activeSkillNames.has(skill.name)),
		};
	}
}

/**
 * 仅迁移控制台旧版本生成、且已经失去对应工具的差旅 Skill。
 * 同名目录若内容不是这份旧模板则保持不动，避免误删用户自己的 Skill。
 */
export function removeObsoleteTravelExpenseSkill(agentDir: string): boolean {
	const skillFile = join(agentDir, "skills", "travel-expense", "SKILL.md");
	if (!existsSync(skillFile)) return false;
	let content: string;
	try {
		content = readFileSync(skillFile, "utf8");
	} catch {
		return false;
	}
	const isLegacySkill =
		/^name:\s*["']?travel-expense-reimbursement["']?\s*$/m.test(content) && content.includes("travel_fill_draft");
	if (!isLegacySkill) return false;
	rmSync(dirname(skillFile), { recursive: true, force: false });
	return true;
}
