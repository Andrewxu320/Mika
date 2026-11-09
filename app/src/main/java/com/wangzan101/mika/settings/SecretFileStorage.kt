package com.wangzan101.mika.settings

import android.util.Log
import com.wangzan101.mika.core.secret.SecretStorage
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * 存下的密钥的落盘:整份 JSON 经 [KeyCipher](安卓密钥库里的 AES)加密,写临时文件再原子替换。
 * 解不开(换过密钥、文件损坏)按「没存过」处理,不抛:工具侧再问用户要一次即可。
 */
class SecretFileStorage(dir: File, private val cipher: KeyCipher) : SecretStorage {
    private val file = File(dir, FILE_NAME)

    override fun load(): String? = runCatching {
        if (!file.isFile) null else String(cipher.decrypt(file.readBytes()), Charsets.UTF_8)
    }.onFailure { Log.w(TAG, "stored keys are unreadable", it) }.getOrNull()

    override fun save(json: String) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "$FILE_NAME.tmp")
        tmp.writeBytes(cipher.encrypt(json.toByteArray(Charsets.UTF_8)))
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    private companion object {
        const val FILE_NAME = "secrets.bin"
        const val TAG = "MikaSecrets"
    }
}
