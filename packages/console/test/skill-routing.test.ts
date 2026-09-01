import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoutedSkillResourceLoader, removeObsoleteTravelExpenseSkill } from "../src/skill-routing.ts";

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-console-skill-routing-"));
	tempDirectories.push(path);
	return path;
}

function writeSkill(agentDir: string, directory: string, name: string, body = "# Test\n"): void {
	const skillDirectory = join(agentDir, "skills", directory);
	mkdirSync(skillDirectory, { recursive: true });
	writeFileSync(
		join(skillDirectory, "SKILL.md"),
		`---\nname: ${name}\ndescription: Test skill\n---\n\n${body}`,
		"utf8",
	);
}

afterEach(() => {
	for (const path of tempDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Skill 按本轮路由", () => {
	it("默认隐藏全部 Skill，并只公开本轮选中的 Skill", async () => {
		const root = makeTempDirectory();
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		writeSkill(agentDir, "alpha", "alpha-skill");
		writeSkill(agentDir, "beta", "beta-skill");

		const loader = new RoutedSkillResourceLoader({ cwd, agentDir });
		await loader.reload();

		expect(loader.getAllSkills().skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["alpha-skill", "beta-skill"]),
		);
		expect(loader.getSkills().skills).toEqual([]);
		loader.setActiveSkillNames(["beta-skill"]);
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["beta-skill"]);
	});

	it("只删除带旧工具签名的差旅 Skill", () => {
		const root = makeTempDirectory();
		const agentDir = join(root, "agent");
		writeSkill(agentDir, "travel-expense", "travel-expense-reimbursement", "调用 travel_fill_draft。\n");
		expect(removeObsoleteTravelExpenseSkill(agentDir)).toBe(true);
		expect(removeObsoleteTravelExpenseSkill(agentDir)).toBe(false);

		writeSkill(agentDir, "travel-expense", "travel-expense-reimbursement", "这是用户自己的新版本。\n");
		expect(removeObsoleteTravelExpenseSkill(agentDir)).toBe(false);
	});
});
