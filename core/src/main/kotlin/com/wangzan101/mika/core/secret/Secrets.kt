package com.wangzan101.mika.core.secret

import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 一条存下的密钥的元数据。值本身只在 [SecretBook.take] 里出现,不返回给模型、不进任何工具结果;
 * [tail] 只留末尾四位,让用户认出是哪一把。
 */
data class SecretMeta(val name: String, val savedAt: Long, val expiresAt: Long, val tail: String) {
    fun expired(now: Long): Boolean = now >= expiresAt

    /** 还剩几天(向上取整;已过期为 0)。 */
    fun daysLeft(now: Long): Int {
        val left = expiresAt - now
        return if (left <= 0) 0 else ((left + DAY_MS - 1) / DAY_MS).toInt()
    }

    private companion object {
        const val DAY_MS = 86_400_000L
    }
}

/**
 * 整份密钥表的落盘。加密由调用方做(app 一侧用 KeyCipher):这里只看见一段 JSON 文本。
 * 读不出来(没存过、解不开)返回 null,不抛。
 */
interface SecretStorage {
    fun load(): String?
    fun save(json: String)
}

/**
 * 存下的密钥:一条一条带名字和到期时刻,整份原子落盘。
 * 到期由这里判定:每次读写先把过期的删掉(并落盘),不靠模型记得。
 *
 * 值只在 [take] 里出现,调用方只能把它交给沙箱进程,不得写进工具结果、运行记录或提示词。
 */
class SecretBook(
    private val storage: SecretStorage,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private var entries: MutableMap<String, StoredSecret>? = null

    /** 存下一个值,[days] 天后到期;同名的换掉旧的。 */
    @Synchronized
    fun put(name: String, value: String, days: Int): SecretMeta {
        val map = live()
        val now = clock()
        val entry = StoredSecret(name, value, now, now + days * DAY_MS)
        map[name] = entry
        persist()
        return SecretMeta(name, entry.savedAt, entry.expiresAt, Secrets.tail(value))
    }

    /** 全部没到期的条目(先删掉过期的)。 */
    @Synchronized
    fun list(): List<SecretMeta> = live().values.map {
        SecretMeta(it.name, it.savedAt, it.expiresAt, Secrets.tail(it.value))
    }

    /** 取一个值给沙箱进程用;没有或已过期(顺带删掉)为 null。 */
    @Synchronized
    fun take(name: String): String? = live()[name]?.value

    /** 删掉一条;本来就没有为 false。 */
    @Synchronized
    fun delete(name: String): Boolean {
        val removed = live().remove(name) != null
        if (removed) persist()
        return removed
    }

    /** 读进内存(null 时才读),顺手清掉过期的并落盘。 */
    private fun live(): MutableMap<String, StoredSecret> {
        val map = load()
        val now = clock()
        val dead = map.values.filter { now >= it.expiresAt }.map { it.name }
        if (dead.isNotEmpty()) {
            dead.forEach(map::remove)
            persist()
        }
        return map
    }

    private fun load(): MutableMap<String, StoredSecret> {
        entries?.let { return it }
        val text = runCatching { storage.load() }.getOrNull()
        val parsed = if (text.isNullOrBlank()) emptyList() else try {
            json.decodeFromString(StoredFile.serializer(), text).secrets
        } catch (e: SerializationException) {
            emptyList()
        }
        return LinkedHashMap<String, StoredSecret>().also { map -> parsed.forEach { map[it.name] = it } }
            .also { entries = it }
    }

    private fun persist() {
        val map = entries ?: return
        val text = json.encodeToString(StoredFile.serializer(), StoredFile(secrets = map.values.toList()))
        runCatching { storage.save(text) }
    }

    private companion object {
        const val DAY_MS = 86_400_000L
    }
}

/** 落盘的一条;只在 [SecretBook] 内部用,值不出去。 */
@Serializable
internal data class StoredSecret(val name: String, val value: String, val savedAt: Long, val expiresAt: Long)

/** 整份密钥表的形状;加密由落盘那一侧做。 */
@Serializable
internal data class StoredFile(val v: Int = 1, val secrets: List<StoredSecret> = emptyList())

/** 密钥名、值、天数的规则;工具与知识一侧共用一处判断。 */
object Secrets {
    /** 名字:小写字母开头,小写字母数字与 - _ ,最长 32。 */
    val NAME = Regex("^[a-z][a-z0-9_-]{0,31}$")

    /** 注入沙箱时的环境变量名:大写字母开头,大写字母数字与 _,最长 64。 */
    val ENV_NAME = Regex("^[A-Z][A-Z0-9_]{0,63}$")

    const val MAX_VALUE = 4096
    const val MIN_DAYS = 1
    const val MAX_DAYS = 365
    const val DEFAULT_DAYS = 30

    /** 末尾四位;太短的值整段不显示。 */
    fun tail(value: String): String = if (value.length <= 4) "••••" else "…" + value.takeLast(4)

    /** 值是凭据:不能有空白和控制字符(它们会让环境变量、命令行出错)。 */
    fun cleanValue(value: String): Boolean =
        value.isNotEmpty() && value.length <= MAX_VALUE && value.none { it.isWhitespace() || it.isISOControl() }

    /** 一次脚本调用要带的环境变量:参数写成 `NAME=entry`。[variable] 给脚本读,[entry] 是存下的密钥名。 */
    data class EnvSpec(val variable: String, val entry: String)

    /** 解析 `NAME=entry`;格式不对为 null(由调用方报错,不猜)。 */
    fun envSpec(raw: String): EnvSpec? {
        val i = raw.indexOf('=')
        if (i <= 0 || i == raw.length - 1) return null
        val variable = raw.substring(0, i).trim()
        val entry = raw.substring(i + 1).trim()
        if (!ENV_NAME.matches(variable) || !NAME.matches(entry)) return null
        return EnvSpec(variable, entry)
    }
}
