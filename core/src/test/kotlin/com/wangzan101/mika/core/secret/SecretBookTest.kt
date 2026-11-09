package com.wangzan101.mika.core.secret

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 落在内存里的整份密钥表(真的落盘由 app 一侧加密写)。 */
private class MemoryStorage(var text: String? = null) : SecretStorage {
    var saves = 0
    override fun load(): String? = text
    override fun save(json: String) {
        text = json
        saves++
    }
}

private const val DAY = 86_400_000L
private const val KEY = "0123456789abcdef0123456789abcdef"

class SecretBookTest {
    private var now = 1_700_000_000_000L
    private fun book(storage: SecretStorage = MemoryStorage()) = SecretBook(storage) { now }

    @Test
    fun storesValueAndReturnsOnlyMeta() {
        val storage = MemoryStorage()
        val meta = book(storage).put("amap", KEY, 30)
        assertEquals("amap", meta.name)
        assertEquals(30, meta.daysLeft(now))
        assertEquals("…cdef", meta.tail)
        assertEquals(now + 30 * DAY, meta.expiresAt)
        // 值确实存下去了,但不在元数据里
        assertFalse(meta.toString().contains(KEY))
    }

    @Test
    fun takesTheValueBack() {
        assertEquals(KEY, book().also { it.put("amap", KEY, 30) }.take("amap"))
        assertNull(book().take("missing"))
    }

    @Test
    fun expiresAndDisappears() {
        val storage = MemoryStorage()
        val b = book(storage)
        b.put("amap", KEY, 30)
        now += 30 * DAY
        assertTrue(b.list().isEmpty())
        assertNull(b.take("amap"))
        // 过期是删除加落盘,不只是读的时候不给
        assertFalse(storage.text.orEmpty().contains(KEY))
    }

    @Test
    fun survivesARestart() {
        val storage = MemoryStorage()
        book(storage).put("amap", KEY, 30)
        assertEquals(KEY, book(storage).take("amap"))
    }

    @Test
    fun overwriteResetsExpiry() {
        val b = book()
        b.put("amap", KEY, 30)
        now += 20 * DAY
        b.put("amap", "second-key-value", 30)
        assertEquals(30, b.list().single().daysLeft(now))
        assertEquals("second-key-value", b.take("amap"))
    }

    @Test
    fun deleteRemovesIt() {
        val storage = MemoryStorage()
        val b = book(storage)
        b.put("amap", KEY, 30)
        assertTrue(b.delete("amap"))
        assertFalse(b.delete("amap"))
        assertNotNull(storage.text)
        assertFalse(storage.text!!.contains(KEY))
    }

    @Test
    fun unreadableStorageBehavesLikeEmpty() {
        val broken = object : SecretStorage {
            override fun load(): String? = "not json"
            override fun save(json: String) = Unit
        }
        assertTrue(book(broken).list().isEmpty())
    }

    @Test
    fun envSpecNeedsNameAndEntry() {
        assertEquals(Secrets.EnvSpec("AMAP_KEY", "amap"), Secrets.envSpec("AMAP_KEY=amap"))
        assertEquals(Secrets.EnvSpec("AMAP_KEY", "amap"), Secrets.envSpec(" AMAP_KEY = amap "))
        assertNull(Secrets.envSpec("amap"))          // 没有 =
        assertNull(Secrets.envSpec("=amap"))         // 没有变量名
        assertNull(Secrets.envSpec("AMAP_KEY="))     // 没有条目
        assertNull(Secrets.envSpec("amap_key=amap")) // 变量名要大写
        assertNull(Secrets.envSpec("AMAP_KEY=Amap")) // 条目名要小写
    }

    @Test
    fun valuesCannotCarryWhitespace() {
        assertTrue(Secrets.cleanValue(KEY))
        assertFalse(Secrets.cleanValue("has space"))
        assertFalse(Secrets.cleanValue("line\nbreak"))
        assertFalse(Secrets.cleanValue(""))
    }
}
