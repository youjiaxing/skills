import com.google.gson.Gson
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.util.Key
import java.nio.file.Files

// Each observation uses a fresh official IDE invocation, independent of the
// original command's coroutine/job. Only an already registered request advances.
def req
try { req = new Gson().fromJson(requestFile.getText('UTF-8'), Map) }
catch (FileNotFoundException ignored) { return }
def app = ApplicationManager.getApplication()
if (ProcessHandle.current().pid() != (req.expectedPid as long) ||
        !Files.isSameFile(new File(PathManager.configPath).toPath(), new File(req.profile).toPath())) return
def key = Key.findKeyByName('yjx.goland.ops.v1')
def registry = key == null ? null : app.getUserData(key)
def record = registry?.requests?.get(req.requestId)
if (record == null) return
if (record.profile != req.profile || record.project != req.project) return
app.invokeLater({
    try {
        if (!record.done && record.tick != null) record.tick()
        if (record.flush != null) record.flush()
    } catch (Throwable t) {
        record.tick = null
        if (record.onError != null) record.onError(t)
        else record.observerError = t.toString()
    }
} as Runnable)
