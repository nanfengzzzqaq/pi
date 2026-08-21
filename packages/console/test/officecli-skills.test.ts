import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	adaptOfficialSkill,
	OFFICECLI_SKILLS,
	officeCliSkillInstallOrder,
	officeCliSkillPath,
	uninstallAllOfficeCliSkills,
} from "../src/officecli-skills.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("OfficeCLI 官方技能目录", () => {
	it("按工具目录保存技能", () => {
		expect(officeCliSkillPath("C:\\pi-agent", "word")).toBe(
			join("C:\\pi-agent", "skills", "officecli", "word", "SKILL.md"),
		);
	});

	it("场景技能会先安装基础技能", () => {
		expect(officeCliSkillInstallOrder("financial-model").map((skill) => skill.id)).toEqual([
			"excel",
			"financial-model",
		]);
		expect(officeCliSkillInstallOrder("morph-ppt-3d").map((skill) => skill.id)).toEqual([
			"pptx",
			"morph-ppt",
			"morph-ppt-3d",
		]);
	});

	it("保留官方正文并换成精简中文描述和 Windows 规则", () => {
		const word = OFFICECLI_SKILLS.find((skill) => skill.id === "word");
		expect(word).toBeDefined();
		const official = [
			"---",
			"name: officecli-docx",
			'description: "A very long official description"',
			"---",
			"",
			"# Official Body",
			"Read `skills/officecli-xlsx/SKILL.md` first.",
			"",
		].join("\n");
		const adapted = adaptOfficialSkill(official, word!);
		expect(adapted).toContain(`description: ${JSON.stringify(word!.description)}`);
		expect(adapted).toContain("## Pi 控制台 Windows 适配");
		expect(adapted).toContain("# Official Body");
		expect(adapted).toContain("`../excel/SKILL.md`");
		expect(adapted).not.toContain("skills/officecli-xlsx/SKILL.md");
		expect(adapted).not.toContain("A very long official description");
	});

	it("卸载时只删除 OfficeCLI 技能分组", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-officecli-skills-"));
		temporaryDirectories.push(agentDir);
		const officeSkill = officeCliSkillPath(agentDir, "word");
		const otherSkill = join(agentDir, "skills", "other-tool", "SKILL.md");
		mkdirSync(dirname(officeSkill), { recursive: true });
		mkdirSync(dirname(otherSkill), { recursive: true });
		writeFileSync(officeSkill, "office");
		writeFileSync(otherSkill, "other");

		expect(uninstallAllOfficeCliSkills(agentDir)).toBe(true);
		expect(existsSync(officeSkill)).toBe(false);
		expect(existsSync(otherSkill)).toBe(true);
		expect(uninstallAllOfficeCliSkills(agentDir)).toBe(false);
	});
});
