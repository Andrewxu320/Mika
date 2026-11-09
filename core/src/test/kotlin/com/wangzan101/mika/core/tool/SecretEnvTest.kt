package com.wangzan101.mika.core.tool

import com.wangzan101.mika.core.assembly.toolDispatcher
import com.wangzan101.mika.core.cap.sandbox.FakeSandbox
import com.wangzan101.mika.core.cap.sandbox.SandboxStatus
import com.wangzan101.mika.core.knowledge.ScriptEntry
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.secret.SecretBook
import com.wangzan101.mika.core.secret.SecretStorage
import java.io.File
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** run_bundled_script 的 secretEnv:值只进这一次进程的环境变量,不进参数、结果和运行记录。 */
class SecretEnvTest {
    private val key = "0123456789abcdef0123456789abcdef"
    private val skill = "skills/roadtrip-review"
    private val script = "scripts/validate-trip.mjs"

    private val sb = FakeSandbox(SandboxStatus.Ready(network = true))
    private val book = SecretBook(object : SecretStorage {
        private var text: String? = null
        override fun load(): String? = text
        override fun save(json: String) { text = json }
    })

    private fun dispatcher() = toolDispatcher(FakeScreen(), sandbox = sb, workspace = { "conv1" }, secrets = book)

    private fun prepareScript() {
        sb.manifests[skill] = listOf(ScriptEntry(script, true, network = true))
        val f = File(sb.skillsDir, "$skill/$script")
        f.parentFile.mkdirs()
        f.writeText("// test script\n")
    }

    private fun call(secrets: List<String>) = Part.ToolCall("c1", "run_bundled_script", buildJsonObject {
        put("source", skill)
        put("script", script)
        put("secretEnv", JsonArray(secrets.map(::JsonPrimitive)))
    }.toString())

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test
    fun storedKeyReachesTheProcessOnly() = runTest {
        prepareScript()
        book.put("amap", key, 30)
        val r = dispatcher().execute(call(listOf("AMAP_KEY=amap"))).content
        assertEquals("true", r.s("ok"))
        assertEquals(key, sb.envs["AMAP_KEY"])
        // 值不出现在结果里,也不出现在交给沙箱的参数里
        assertFalse(r.toString().contains(key))
        assertTrue(sb.runs.single().argv.none { it.contains(key) })
    }

    @Test
    fun missingKeyIsRefusedBeforeRunning() = runTest {
        prepareScript()
        val r = dispatcher().execute(call(listOf("AMAP_KEY=amap"))).content
        assertEquals("secret_missing", r.s("error"))
        assertTrue(sb.runs.isEmpty())
    }

    @Test
    fun expiredKeyIsRefused() = runTest {
        prepareScript()
        var now = 1_000_000L
        val timed = SecretBook(object : SecretStorage {
            private var text: String? = null
            override fun load(): String? = text
            override fun save(json: String) { text = json }
        }, clock = { now })
        timed.put("amap", key, 30)
        now += 31L * 86_400_000L
        val d = toolDispatcher(FakeScreen(), sandbox = sb, workspace = { "conv1" }, secrets = timed)
        val r = d.execute(call(listOf("AMAP_KEY=amap"))).content
        assertEquals("secret_missing", r.s("error"))
        assertTrue(sb.runs.isEmpty())
    }

    @Test
    fun malformedSpecIsRejected() = runTest {
        prepareScript()
        book.put("amap", key, 30)
        val r = dispatcher().execute(call(listOf("amap"))).content
        assertEquals("secret_env_invalid", r.s("error"))
        assertTrue(sb.runs.isEmpty())
    }
}
