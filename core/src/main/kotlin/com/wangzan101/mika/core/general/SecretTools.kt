package com.wangzan101.mika.core.general

import com.wangzan101.mika.core.prompt.Prompts
import com.wangzan101.mika.core.secret.SecretMeta
import com.wangzan101.mika.core.secret.Secrets
import com.wangzan101.mika.core.tool.AgentTool
import com.wangzan101.mika.core.tool.ArgError
import com.wangzan101.mika.core.tool.Args
import com.wangzan101.mika.core.tool.Risk
import com.wangzan101.mika.core.tool.ToolContext
import com.wangzan101.mika.core.tool.ToolDef
import com.wangzan101.mika.core.tool.ToolExecution
import com.wangzan101.mika.core.tool.Verb
import com.wangzan101.mika.core.tool.int
import com.wangzan101.mika.core.tool.ok
import com.wangzan101.mika.core.tool.str
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 存密钥:值加密存在本机,工具结果里只回去名字、末尾四位和到期时间。
 * 沙箱脚本经 run_bundled_script 的 secretEnv 拿到它(作为那一次进程的环境变量),模型看不到明文。
 */
internal object SecretSave : AgentTool {
    override val verb = Verb.SecretSave
    override val label = "存密钥"
    // 只动 Mika 自己的存储,不动屏幕和外部世界(和 memory_save 同一档)
    override val risk = Risk.Read
    override val def = ToolDef("secret_save",
        Prompts.tool("secret_save"),
        mapOf(
            "name" to str("Short name to keep it under, e.g. amap: lowercase letters, digits, - and _, up to 32."),
            "value" to str("The key or token itself. Stored encrypted; never shown to you again."),
            "days" to int("Days until it expires (1-365, default 30).", Secrets.MIN_DAYS, Secrets.MAX_DAYS),
        ), listOf("name", "value"))

    override fun available(ctx: ToolContext) = ctx.config.secrets != null

    override suspend fun execute(a: Args, ctx: ToolContext): ToolExecution {
        val name = a.str("name", max = 32)!!
        if (!Secrets.NAME.matches(name)) throw ArgError("name", "must start with a lowercase letter and use only lowercase letters, digits, - and _")
        val value = a.str("value", max = Secrets.MAX_VALUE)!!.trim()
        if (!Secrets.cleanValue(value)) throw ArgError("value", "must be 1-${Secrets.MAX_VALUE} characters with no spaces or line breaks")
        val days = a.int("days", Secrets.MIN_DAYS, Secrets.MAX_DAYS) ?: Secrets.DEFAULT_DAYS
        val book = ctx.config.secrets!!
        val meta = withContext(Dispatchers.IO) { book.put(name, value, days) }
        return ok {
            put("name", meta.name)
            put("expiresAt", Instant.ofEpochMilli(meta.expiresAt).toString())
            put("daysLeft", meta.daysLeft(System.currentTimeMillis()))
            put("tail", meta.tail)
        }
    }
}

/** 看存了哪些、还剩几天;过期了的当场删除并报出来。 */
internal object SecretStatus : AgentTool {
    override val verb = Verb.SecretStatus
    override val label = "查密钥"
    override val risk = Risk.Read
    override val def = ToolDef("secret_status",
        Prompts.tool("secret_status"),
        mapOf("name" to str("Optional name to look at; omit for all.")), emptyList())

    override fun available(ctx: ToolContext) = ctx.config.secrets != null

    override suspend fun execute(a: Args, ctx: ToolContext): ToolExecution {
        val want = a.str("name", max = 32)
        val book = ctx.config.secrets!!
        val now = System.currentTimeMillis()
        val found: List<SecretMeta> = withContext(Dispatchers.IO) { book.list() }
            .filter { want == null || it.name == want }
        return ok {
            put("secrets", JsonArray(found.map { meta ->
                buildJsonObject {
                    put("name", meta.name)
                    put("expiresAt", Instant.ofEpochMilli(meta.expiresAt).toString())
                    put("daysLeft", meta.daysLeft(now))
                    put("tail", meta.tail)
                }
            }))
            // 问的那一条已经不在了(没存过、或到期被删掉):说清是哪种,不用报错码
            if (want != null && found.isEmpty()) put("found", false)
        }
    }
}

/** 删掉一条(用户要求、或那把 Key 已经不能用时)。 */
internal object SecretDelete : AgentTool {
    override val verb = Verb.SecretDelete
    override val label = "删密钥"
    override val risk = Risk.Read
    override val def = ToolDef("secret_delete",
        Prompts.tool("secret_delete"),
        mapOf("name" to str("Name it was stored under.")), listOf("name"))

    override fun available(ctx: ToolContext) = ctx.config.secrets != null

    override suspend fun execute(a: Args, ctx: ToolContext): ToolExecution {
        val name = a.str("name", max = 32)!!
        val book = ctx.config.secrets!!
        val deleted = withContext(Dispatchers.IO) { book.delete(name) }
        return ok { put("name", name); put("deleted", deleted) }
    }
}
