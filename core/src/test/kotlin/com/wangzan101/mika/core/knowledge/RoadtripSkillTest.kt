package com.wangzan101.mika.core.knowledge

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 随包的 roadtrip-review(从 lulu-road-trip-planner 同步来的技能):脚本、清单、许可证与说明自洽。
 *
 * 脚本路径在这里逐条写死:`BundledScriptsManifestTest.everyShippedScriptHasATest` 要求每个随包脚本
 * 都在某个测试文件里以「技能目录 + 脚本路径」的字面量出现过,下面这些字面量就是那份凭据。
 */
class RoadtripSkillTest {
    private val skill = "skills/roadtrip-review"
    private val scripts = listOf(
        "scripts/validate-trip.mjs",
        "scripts/render-report.mjs",
        "scripts/render-map.mjs",
        "scripts/render-overview.mjs",
        "scripts/render-bundle.mjs",
        "scripts/diff-assessments.mjs",
        "scripts/fetch-amap-route.mjs",
    )
    private val root = File(GuideCatalog::class.java.classLoader.getResource(KnowledgeIndex.RESOURCE)!!.toURI())
        .parentFile.parentFile
    private val dir = File(root, skill)

    @Test
    fun everyScriptIsPackaged() {
        for (script in scripts) assertTrue("$skill/$script 没有随包", File(dir, script).isFile)
        assertTrue("缺少上游许可证原文", File(dir, "LICENSE.lulu.md").isFile)
    }

    @Test
    fun manifestListsEveryScript() {
        val manifest = File(dir, "scripts/manifest.json").readText()
        for (script in scripts) assertTrue("$script 不在 manifest 里", "\"$script\"" in manifest)
    }

    @Test
    fun skillSaysWhereTheGateIs() {
        val md = File(dir, "SKILL.md").readText()
        // 交付前必须跑校验、渲染由 render-bundle 内部控制
        assertTrue("SKILL.md 没写校验脚本", "scripts/validate-trip.mjs" in md)
        assertTrue("SKILL.md 没写渲染脚本", "scripts/render-bundle.mjs" in md)
        val adapter = File(dir, "references/mika-adapter.md").readText()
        assertTrue("适配器没写导出闸门", "validation.json" in adapter)
        assertTrue("适配器没写产物过期的错误码", "trip_artifacts_stale" in adapter)
    }

    @Test
    fun scriptsCarryTheirUpstreamLicense() {
        for (script in scripts) {
            val text = File(dir, script).readText()
            val head = text.lines().take(3).joinToString("\n")
            assertTrue("$script 缺 SPDX 头", "SPDX-License-Identifier: MIT" in head)
            assertTrue("$script 缺 Usage:", "Usage:" in text)
        }
    }
}
