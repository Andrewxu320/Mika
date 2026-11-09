package com.wangzan101.mika.core.cap.sandbox

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 行程目录里的产物要先过校验才许导出;别的目录不受影响。 */
class ShareRulesTripGateTest {
    private fun dir(): File = Files.createTempDirectory("mika-trip").toFile().also { it.deleteOnExit() }

    private fun trip(d: File, revision: String = "rev-1") =
        File(d, "trip.json").writeText("""{"trip":{"revision":"$revision"},"days":{},"stops":{}}""")

    private fun validation(d: File, body: String = """{"valid":true,"errorCount":0}""") =
        File(d, "validation.json").writeText(body)

    private fun manifest(d: File, revision: String) =
        File(d, "manifest.json").writeText("""{"tripRevision":"$revision"}""")

    @Test
    fun ordinaryFolderIsNotATrip() {
        val d = dir()
        File(d, "note.md").writeText("hello")
        assertNull(ShareRules.tripProblem(d))
        assertNull(ShareRules.tripProblem(null))
    }

    @Test
    fun tripWithoutValidationIsBlocked() {
        val d = dir()
        trip(d)
        assertEquals("trip_not_validated", ShareRules.tripProblem(d)?.first)
    }

    @Test
    fun failingValidationIsBlocked() {
        val d = dir()
        trip(d)
        validation(d, """{"valid":false,"errorCount":3}""")
        assertEquals("trip_not_valid", ShareRules.tripProblem(d)?.first)
    }

    @Test
    fun unreadableValidationIsBlocked() {
        val d = dir()
        trip(d)
        validation(d, "not json")
        assertEquals("trip_validation_unreadable", ShareRules.tripProblem(d)?.first)
    }

    @Test
    fun staleArtifactsAreBlocked() {
        val d = dir()
        trip(d, revision = "rev-3")
        validation(d)
        manifest(d, revision = "rev-2")
        assertEquals("trip_artifacts_stale", ShareRules.tripProblem(d)?.first)
    }

    @Test
    fun matchingRevisionPasses() {
        val d = dir()
        trip(d, revision = "rev-3")
        validation(d)
        manifest(d, revision = "rev-3")
        assertNull(ShareRules.tripProblem(d))
    }

    @Test
    fun validationWithoutManifestPasses() {
        val d = dir()
        trip(d)
        validation(d)
        assertNull(ShareRules.tripProblem(d))
    }
}
