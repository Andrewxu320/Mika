package com.wangzan101.mika.core.record

import com.wangzan101.mika.core.tool.Verb
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 存下的密钥:高德这类 32 位十六进制的 Key 不在 Redactor 的形状里,要按字段整段打码。 */
class SecretRedactionTest {
    @Test
    fun secretValueNeverReachesTheRunRecord() {
        val key = "0123456789abcdef0123456789abcdef"
        val out = Redactor.args(Verb.SecretSave, """{"name":"amap","value":"$key"}""", false)
        assertFalse(out.contains(key))
        assertTrue(out.contains(Redactor.MASK))
        assertFalse(out.contains(key.substring(0, 8)))
    }

    @Test
    fun nameStaysReadable() {
        val out = Redactor.args(Verb.SecretSave, """{"name":"amap","value":"0123456789abcdef0123456789abcdef"}""", false)
        assertTrue(out.contains("amap"))
    }

    @Test
    fun otherToolsKeepTheirArguments() {
        val out = Redactor.args(Verb.ReadFile, """{"path":"/workspace/a.txt"}""", false)
        assertTrue(out.contains("/workspace/a.txt"))
    }
}
