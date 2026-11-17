#define DECKY_LIVE_TEST 1
#include "../live.cpp"

using namespace live;

static unsigned passed, failed;
static char report[8192];
static size_t reportUsed;

static void Check(bool ok, const char* expression, int line) {
    if (ok) {
        ++passed;
        return;
    }
    ++failed;
    int n = snprintf(report + reportUsed, sizeof(report) - reportUsed,
                     "FAIL line %d: %s\n", line, expression);
    if (n > 0 && static_cast<size_t>(n) < sizeof(report) - reportUsed)
        reportUsed += static_cast<size_t>(n);
}

#define CHECK(E) Check(!!(E), #E, __LINE__)

static void PutString(msvc_string* value, const char* text) {
    memset(value, 0, sizeof(*value));
    value->capacity = 15;
    value->size = strlen(text);
    memcpy(value->bx.buf, text, value->size + 1);
}

static void PutWideString(msvc_wstring* value, const wchar_t* text) {
    memset(value, 0, sizeof(*value));
    value->size = wcslen(text);
    value->capacity = value->size > 7 ? value->size : 7;
    if (value->size > 7)
        value->bx.ptr = const_cast<wchar16*>(reinterpret_cast<const wchar16*>(text));
    else
        memcpy(value->bx.buf, text, (value->size + 1) * sizeof(wchar16));
}

template <class T> static void Store(size_t offset, const T& value) {
    memcpy(g_coreBase + kStateRva + offset, &value, sizeof(value));
}

static bool TestDirectoryMatch(uintptr_t config) {
    return g_controlOwned && g_directoryAuth.verified &&
        config == g_directoryAuth.config;
}

static bool FakeRenderMenu() { return true; }

struct Fixture {
    Config* config = nullptr;
    BYTE* fg = nullptr;
    BYTE* feature = nullptr;
    BackendEntry entries[2]{};
    uint64_t buckets[4]{};
    const char* upNames[2] = {"3.1.5", "4.1.1b"};
    const char* fgNames[2] = {"3.1.5", "3.1.6"};
    uint64_t upIds[2] = {111, 222};
    uint64_t fgIds[2] = {333, 444};

    Fixture() {
        g_coreBase = static_cast<BYTE*>(VirtualAlloc(
            NULL, pe_size_of_image, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
        config = static_cast<Config*>(VirtualAlloc(
            NULL, 8192, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
        fg = static_cast<BYTE*>(VirtualAlloc(
            NULL, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
        feature = static_cast<BYTE*>(VirtualAlloc(
            NULL, 3 * 1024 * 1024, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
        CHECK(g_coreBase && config && fg && feature);
        if (!g_coreBase || !config || !fg || !feature) return;

        g_core = reinterpret_cast<HMODULE>(g_coreBase);
        g_coreImageSize = pe_size_of_image;
        g_dataSectionCount = 1;
        g_dataSections[0] = {0, pe_size_of_image};
        g_coreValid = g_coreHashValid = true;
        const uintptr_t configAddress = reinterpret_cast<uintptr_t>(config);
        memcpy(g_coreBase + kConfigPointerRva, &configAddress, sizeof(configAddress));

        strcpy(g_session, "test-session");
        strcpy(g_exeName, "fixture.exe");
        g_started = g_inCallback = 0;
        g_callbackAuthorized = 1;
        g_hookInstalled = true;
        g_renderMenu = &FakeRenderMenu;
        g_startError = "";
        g_hasQueued = false;
        g_lastSequence = 0;
        g_lastFrame = GetTickCount64();
        g_queuedSince = 0;
        memset(&g_result, 0, sizeof(g_result));
        memset(&g_queued, 0, sizeof(g_queued));
        memset(&g_snapshot, 0, sizeof(g_snapshot));
        g_telemetryFeature = 0;
        g_telemetryFeatureFrames = 0;
        g_telemetryStateFrames = 0;
        g_telemetryTick = g_featureProgressTick = g_presentProgressTick = 0;
        g_presentCounterFps = g_lastRenderedInterval = g_lastPresentedInterval = 0;
        g_renderedIntervalTick = g_presentedIntervalTick = 0;

        g_controlOwned = true;
        g_directoryAuth = {};
        g_directoryAuth.verified = true;
        g_directoryAuth.generation = ++g_directoryGeneration;
        g_directoryAuth.config = configAddress;
        wcscpy(g_directoryAuth.path, L"C:\\fixture\\OptiScaler.ini");
        g_testDirectoryAuthMatches = &TestDirectoryMatch;

        config->ShortcutKey.defaultValue = VK_INSERT;
        config->FpsShortcutKey.defaultValue = VK_PRIOR;
        config->FGShortcutKey.defaultValue = VK_END;
        config->FontSize.defaultValue = 14.0f;
        config->Sharpness.defaultValue = 0.4f;
        config->DlssReactiveMaskBias.defaultValue = 0.45f;
        PutWideString(&config->fileName, L"OptiScaler.ini");
        PutWideString(&config->absoluteFileName.text, L"C:\\fixture\\OptiScaler.ini");
        config->FGEnabled.assign(true);
        config->FGHUDFix.assign(false);
        config->FGDebugView.assign(false);
        config->FGMakeDepthCopy.assign(false);
        config->FGHUDFixExtended.assign(false);
        config->FGXeFGInterpolationCount.assign(1);
        config->FfxFGIndex.assign(0);
        config->FfxUpscalerIndex.assign(0);
        config->DLSSEnabled.assign(true);
        config->OverrideSharpness.assign(false);
        config->Sharpness.assign(0.4f);
        config->ShowFps.assign(false);
        PutString(&config->Dx11Upscaler.defaultValue, "fsr31");
        PutString(&config->Dx12Upscaler.defaultValue, "fsr31");
        PutString(&config->VulkanUpscaler.defaultValue, "fsr31");
        PutString(&config->Dx11Upscaler.base.value, "fsr31");
        PutString(&config->Dx12Upscaler.base.value, "fsr31");
        PutString(&config->VulkanUpscaler.base.value, "fsr31");
        config->Dx11Upscaler.base.engaged = true;
        config->Dx12Upscaler.base.engaged = true;
        config->VulkanUpscaler.base.engaged = true;

        PutString(reinterpret_cast<msvc_string*>(g_coreBase + kStateRva), "fixture.exe");
        PutString(reinterpret_cast<msvc_string*>(g_coreBase + kStateRva + 32), "");
        PutString(reinterpret_cast<msvc_string*>(g_coreBase + kStateRva + 64), "");
        PutString(reinterpret_cast<msvc_string*>(g_coreBase + kStateRva + state_offsets_newBackend), "");

        entries[0] = {10, 0, {0, 0, 0}};
        entries[1] = {11, 0, {0, 0, 0}};
        DenseTable table{};
        table.values = {entries, entries + 2, entries + 2};
        table.buckets = {buckets, buckets + 4, buckets + 4};
        table.max = 3;
        table.load = 0.8f;
        table.shifts = 62;
        Store(state_offsets_changeBackend, table);

        msvc_vector_raw values{upNames, upNames + 2, upNames + 2};
        Store(state_offsets_ffxUpscalerVersionNames, values);
        values = {upIds, upIds + 2, upIds + 2};
        Store(state_offsets_ffxUpscalerVersionIds, values);
        values = {fgNames, fgNames + 2, fgNames + 2};
        Store(state_offsets_ffxFGVersionNames, values);
        values = {fgIds, fgIds + 2, fgIds + 2};
        Store(state_offsets_ffxFGVersionIds, values);

        Store(state_offsets_api, uint32_t(2));
        Store(state_offsets_swapchainApi, uint32_t(2));
        Store(state_offsets_activeFgInput, uint32_t(5));
        Store(state_offsets_activeFgOutput, uint32_t(2));
        Store(state_offsets_workingMode, uint32_t(0));
        Store(state_offsets_currentFGSwapchain, uintptr_t(0x98760));
        Store(state_offsets_xefgMaxInterpolationCount, int32_t(3));
        Store(state_offsets_frameCount, uint64_t(0));
        Store(state_offsets_FGLastFrame, uint64_t(100));
        Store(state_offsets_lastFGFrameTime, 16.0);
        Store(state_offsets_presentFrameTime, 8.0);
        MakeFG(2);
        MakeFeature(2, "fsr31");
        g_snapshot = SnapshotNow();
    }

    ~Fixture() {
        if (config) VirtualFree(config, 0, MEM_RELEASE);
        if (fg) VirtualFree(fg, 0, MEM_RELEASE);
        if (feature) VirtualFree(feature, 0, MEM_RELEASE);
        if (g_coreBase) VirtualFree(g_coreBase, 0, MEM_RELEASE);
        g_coreBase = nullptr;
        g_core = nullptr;
        g_coreValid = g_coreHashValid = false;
        g_testDirectoryAuthMatches = nullptr;
        g_controlOwned = false;
    }

    void MakeFG(unsigned output) {
        memset(fg, 0, 4096);
        const bool fsr = output == 2;
        const size_t physical = fsr ? fg_offsets_dx12_subobject : xefg_offsets_dx12_subobject;
        const size_t base = fsr ? fg_offsets_virtual_base : xefg_offsets_virtual_base;
        *reinterpret_cast<uintptr_t*>(fg) = reinterpret_cast<uintptr_t>(g_coreBase) +
            (fsr ? fg_offsets_root_vbtable_rva : xefg_offsets_root_vbtable_rva);
        *reinterpret_cast<uintptr_t*>(fg + physical) = reinterpret_cast<uintptr_t>(g_coreBase) +
            (fsr ? fg_offsets_dx12_vtable_rva : xefg_offsets_dx12_vtable_rva);
        *reinterpret_cast<uintptr_t*>(fg + physical + 8) = reinterpret_cast<uintptr_t>(g_coreBase) +
            (fsr ? fg_offsets_dx12_vbtable_rva : xefg_offsets_dx12_vbtable_rva);
        *reinterpret_cast<uintptr_t*>(fg + base) = reinterpret_cast<uintptr_t>(g_coreBase) +
            (fsr ? fg_offsets_virtual_vtable_rva : xefg_offsets_virtual_vtable_rva);
        *reinterpret_cast<uintptr_t*>(fg + 8) = 0x12340;
        *reinterpret_cast<uintptr_t*>(fg + 16) = 0x45670;
        fg[base + 536] = 1;
        const uint32_t version[3] = {3, 1, 5};
        if (fsr) memcpy(fg + 32, version, sizeof(version));
        Store(state_offsets_currentFG, reinterpret_cast<uintptr_t>(fg + physical));
        Store(state_offsets_activeFgOutput, output);
    }

    void MakeFeature(unsigned api, const char* code) {
        const BackendType* chosen = nullptr;
        for (const auto& type : backend_types)
            if (type.api == api && !strcmp(type.code, code)) { chosen = &type; break; }
        CHECK(chosen != nullptr);
        if (!chosen) return;
        memset(feature, 0, 3 * 1024 * 1024);
        BYTE* object = feature + chosen->physical_offset;
        *reinterpret_cast<uintptr_t*>(object) = reinterpret_cast<uintptr_t>(g_coreBase) +
            chosen->interface_vtable_rva;
        object[feature_offsets_is_inited] = 1;
        *reinterpret_cast<uint32_t*>(object + feature_offsets_render_width) = 1280;
        *reinterpret_cast<uint32_t*>(object + feature_offsets_display_width) = 1920;
        *reinterpret_cast<uint32_t*>(object + feature_offsets_frame_count) = 100;
        Store(state_offsets_currentFeature, reinterpret_cast<uintptr_t>(object));
        Store(state_offsets_api, api);
        Store(state_offsets_swapchainApi, api);
    }

    Snapshot SnapshotNow() {
        Snapshot value;
        CHECK(Capture(&value));
        return value;
    }

    bool MakeBatch(const char* operations, const Snapshot& snapshot, uint64_t seq,
                   Batch* batch, const char** error = nullptr) {
        char wire[limits_command_bytes + 1];
        int n = snprintf(wire, sizeof(wire), "schema 7\nsession %s\nseq %llu\napi %s\ngeneration %s\n%s",
                         g_session, static_cast<unsigned long long>(seq), ApiName(snapshot.api),
                         snapshot.generation, operations);
        if (n <= 0 || static_cast<size_t>(n) >= sizeof(wire)) return false;
        const char* localError = nullptr;
        bool ok = ParseBatch(wire, static_cast<size_t>(n), batch,
                             error ? error : &localError);
        if (ok) batch->directoryGeneration = snapshot.directoryGeneration;
        return ok;
    }

    bool ApplyOperations(const char* operations, uint64_t seq = 1) {
        Snapshot snapshot = SnapshotNow();
        Batch batch{};
        CHECK(MakeBatch(operations, snapshot, seq, &batch));
        if (!batch.count) return false;
        Store(state_offsets_FGchanged, BYTE(0));
        Store(state_offsets_SCchanged, BYTE(0));
        Store(state_offsets_ClearCapturedHudlesses, BYTE(0));
        const bool accepted = Apply(batch, snapshot);
        CHECK(accepted);
        CHECK(!strcmp(g_result.ack, "config_request_accepted"));
        CHECK(g_result.acceptedCount == batch.count);
        CHECK(!g_hasQueued);
        return accepted;
    }
};

static void TestProtocol() {
    Fixture fixture;
    CHECK(MenuNotInitialized());
    BYTE initialized = 1;
    memcpy(g_coreBase + rva_menu_inited, &initialized, sizeof(initialized));
    CHECK(!MenuNotInitialized());
    CHECK(fixture.ApplyOperations("set ShowFps bool 1\n"));
    CHECK(fixture.config->ShowFps.value_or_default());
    Snapshot snapshot = fixture.SnapshotNow();
    Batch batch{};
    CHECK(fixture.MakeBatch("set Sharpness f32 1.3\n", snapshot, 2, &batch));
    CHECK(!fixture.MakeBatch("set ShowFps bool true\n", snapshot, 3, &batch));

    const char* error = nullptr;
    char oldSchema[128];
    int n = snprintf(oldSchema, sizeof(oldSchema),
        "schema 6\nsession test-session\nseq 4\napi dx12\ngeneration %s\nset ShowFps bool 1\n",
        snapshot.generation);
    CHECK(n > 0 && !ParseBatch(oldSchema, static_cast<size_t>(n), &batch, &error));
    CHECK(!fixture.MakeBatch("set ShowFps bool 1\nset ShowFps bool 0\n", snapshot, 5, &batch));
    CHECK(!fixture.MakeBatch("set Fsr4ForceEnableInt8 i32 1\n", snapshot, 6, &batch));
}

static void TestAllMenuOperations() {
    Fixture fixture;
    CHECK(fixture.ApplyOperations("set FGEnabled bool 1\n"));
    CHECK(fixture.ApplyOperations("set FGHUDFix bool 0\n", 2));
    CHECK(fixture.ApplyOperations("set FGDebugView bool 1\n", 3));
    CHECK(fixture.ApplyOperations("set FGMakeDepthCopy bool 1\n", 4));
    CHECK(fixture.ApplyOperations("set FGHUDFixExtended bool 1\n", 5));

    fixture.MakeFG(4);
    CHECK(fixture.ApplyOperations("set FGXeFGInterpolationCount i32 2\n", 6));
    fixture.MakeFG(2);
    CHECK(fixture.ApplyOperations("fgindex 1\n", 7));
    fixture.MakeFeature(2, "fsr31");
    CHECK(fixture.ApplyOperations("ffxupscaler 1\n", 8));

    fixture.MakeFeature(1, "fsr31");
    CHECK(fixture.ApplyOperations("backend fsr22\n", 1));
    fixture.MakeFeature(2, "fsr31");
    CHECK(fixture.ApplyOperations("backend fsr22\n", 2));
    fixture.MakeFeature(3, "fsr31");
    CHECK(fixture.ApplyOperations("backend fsr31_12\n", 3));

    CHECK(fixture.ApplyOperations("set OverrideSharpness bool 1\n", 9));
    CHECK(fixture.ApplyOperations("set Sharpness f32 1.3\n", 10));
    CHECK(fixture.ApplyOperations("set ShowFps bool 0\n", 11));
}

static void TestBackendAcknowledgesOnlyConfiguration() {
    Fixture fixture;
    CHECK(fixture.ApplyOperations("backend fsr22\n", 12));
    CHECK(!strcmp(g_result.ack, "config_request_accepted"));
    Snapshot observed = fixture.SnapshotNow();
    CHECK(!strcmp(observed.actualBackend, "fsr31"));
    CHECK(!strcmp(observed.pending, "fsr22"));
}

static void TestMenuSideEffectsAndInactiveFGOptions() {
    {
        Fixture fixture;
        fixture.config->DisableReactiveMask.assign(true);
        fixture.config->DlssReactiveMaskBias.assign(0.8f);
        CHECK(fixture.ApplyOperations("backend xess\n"));
        CHECK(!fixture.config->DisableReactiveMask.has_value());
        CHECK(!fixture.config->DlssReactiveMaskBias.has_value());
    }
    {
        Fixture fixture;
        fixture.MakeFeature(2, "dlss");
        Snapshot snapshot = fixture.SnapshotNow();
        *reinterpret_cast<uint32_t*>(snapshot.feature - dlss_version_behind_interface) = 2;
        CHECK(fixture.ApplyOperations("set OverrideSharpness bool 1\n"));
        snapshot = fixture.SnapshotNow();
        CHECK(!strcmp(snapshot.pending, "dlss"));
        CHECK(fixture.entries[0].changed && fixture.entries[1].changed);
        PutString(reinterpret_cast<msvc_string*>(g_coreBase + kStateRva + state_offsets_newBackend), "");
        fixture.entries[0].changed = fixture.entries[1].changed = 0;
        *reinterpret_cast<uint32_t*>(snapshot.feature - dlss_version_behind_interface) = 3;
        CHECK(fixture.ApplyOperations("set OverrideSharpness bool 0\n", 2));
        CHECK(!fixture.entries[0].changed && !fixture.entries[1].changed);
        fixture.MakeFeature(2, "dlssd");
        CHECK(!fixture.SnapshotNow().backend);
        CHECK(fixture.SnapshotNow().canOverrideSharpness);
        CHECK(fixture.ApplyOperations("set OverrideSharpness bool 1\n", 3));
    }
    {
        Fixture fixture;
        fixture.config->FGEnabled.assign(false);
        fixture.fg[fg_offsets_virtual_base + 536] = 0;
        CHECK(fixture.ApplyOperations("fgindex 1\n"));
        CHECK(fixture.ApplyOperations("set FGHUDFix bool 1\n", 2));
        fixture.MakeFG(4);
        CHECK(fixture.ApplyOperations("set FGXeFGInterpolationCount i32 2\n", 3));
        fixture.MakeFeature(1, "fsr31");
        CHECK(!MenuBackendAllowed(fixture.SnapshotNow(), "xess"));
        Store(state_offsets_currentD3D11AdepterDesc + offsetof(DXGI_ADAPTER_DESC, VendorId), uint32_t(0x8086));
        CHECK(MenuBackendAllowed(fixture.SnapshotNow(), "xess"));
        CHECK(!MenuBackendAllowed(fixture.SnapshotNow(), "dlssd"));
    }
}

static void TestFgRuntimeActivity() {
    for(unsigned output=2;output<=4;output+=2) {
        Fixture fixture;
        fixture.MakeFG(output);
        const size_t base=output==2?fg_offsets_virtual_base:xefg_offsets_virtual_base;
        CHECK(fixture.SnapshotNow().fgActive);
        fixture.fg[base+ifg_state_active]=0;
        CHECK(!fixture.SnapshotNow().fgActive);
        fixture.fg[base+ifg_state_waiting]=1;
        CHECK(fixture.SnapshotNow().fgActive);
        *reinterpret_cast<uint64_t*>(fixture.fg+base+ifg_state_frames)=10;
        *reinterpret_cast<uint64_t*>(fixture.fg+base+ifg_state_target)=10;
        CHECK(!fixture.SnapshotNow().fgActive);
        *reinterpret_cast<uint64_t*>(fixture.fg+base+ifg_state_frames)=11;
        CHECK(fixture.SnapshotNow().fgActive);
    }
}

static void TestSelectionAndDirectoryRejection() {
    Fixture fixture;
    Snapshot original = fixture.SnapshotNow();
    Batch stale{};
    CHECK(fixture.MakeBatch("set ShowFps bool 1\n", original, 13, &stale));
    fixture.upIds[0] = 222;
    fixture.upIds[1] = 111;
    Snapshot changed = fixture.SnapshotNow();
    BYTE before[sizeof(Config)];
    memcpy(before, fixture.config, sizeof(before));
    CHECK(!Apply(stale, changed));
    CHECK(!memcmp(before, fixture.config, sizeof(before)));
    CHECK(!strcmp(g_result.ack, "rejected"));
    CHECK(!strcmp(g_result.error, "selection_context_changed"));

    fixture.upIds[0] = 111;
    fixture.upIds[1] = 222;
    Snapshot current = fixture.SnapshotNow();
    Batch unauthorized{};
    CHECK(fixture.MakeBatch("set ShowFps bool 1\n", current, 14, &unauthorized));
    g_testDirectoryAuthMatches = [](uintptr_t) { return false; };
    CHECK(!Apply(unauthorized, current));
    CHECK(!strcmp(g_result.ack, "rejected"));
    CHECK(!strcmp(g_result.error, "directory_authorization_changed"));
}

static void Receive(const char* wire, size_t length) {
    AcquireSRWLockExclusive(&g_lock);
    ReceiveCommand(wire, length);
    ReleaseSRWLockExclusive(&g_lock);
}

static size_t BuildWire(char* output, size_t capacity, const char* operations,
                        uint64_t seq, const Snapshot& snapshot,
                        const char* session = "test-session") {
    int n = snprintf(output, capacity,
        "schema 7\nsession %s\nseq %llu\napi %s\ngeneration %s\n%s",
        session, static_cast<unsigned long long>(seq), ApiName(snapshot.api),
        snapshot.generation, operations);
    CHECK(n > 0 && static_cast<size_t>(n) < capacity);
    return n > 0 && static_cast<size_t>(n) < capacity ? static_cast<size_t>(n) : 0;
}

static void TestMailboxAndCallback() {
    Fixture fixture;
    Snapshot snapshot = fixture.SnapshotNow();
    g_snapshot = snapshot;
    char wire[512];
    size_t length = BuildWire(wire, sizeof(wire), "set ShowFps bool 1\n", 1, snapshot);
    Receive(wire, length);
    CHECK(g_hasQueued);
    CHECK(!strcmp(g_result.ack, "pending"));
    CHECK(!fixture.config->ShowFps.value_or_default());

    BYTE menuReady = 1;
    memcpy(g_coreBase + rva_menu_inited, &menuReady, sizeof(menuReady));
    CHECK(RenderMenuHook());
    CHECK(!g_hasQueued);
    CHECK(!strcmp(g_result.ack, "config_request_accepted"));
    CHECK(fixture.config->ShowFps.value_or_default());
    CHECK(g_result.acceptedCount == 1);
}

static void TestNoCallbackReleasesMailbox() {
    Fixture fixture;
    Snapshot snapshot = fixture.SnapshotNow();
    g_snapshot = snapshot;
    g_callbackAuthorized = 0;
    char wire[512];
    size_t length = BuildWire(wire, sizeof(wire), "set ShowFps bool 1\n", 1, snapshot);
    Receive(wire, length);
    CHECK(g_hasQueued);
    CHECK(!fixture.config->ShowFps.value_or_default());
    CHECK(RenderMenuHook());
    CHECK(g_hasQueued);
    CHECK(!strcmp(g_result.ack, "pending"));
    ExpireCommands(g_queuedSince + limits_callback_timeout_ms + 1);
    CHECK(!g_hasQueued);
    CHECK(!strcmp(g_result.ack, "rejected"));
    CHECK(!fixture.config->ShowFps.value_or_default());

    g_callbackAuthorized = 1;
    length = BuildWire(wire, sizeof(wire), "set ShowFps bool 1\n", 2, snapshot);
    Receive(wire, length);
    CHECK(g_hasQueued);
    BYTE menuReady = 1;
    memcpy(g_coreBase + rva_menu_inited, &menuReady, sizeof(menuReady));
    CHECK(RenderMenuHook());
    CHECK(!g_hasQueued);
    CHECK(!strcmp(g_result.ack, "config_request_accepted"));
}

static void TestStatusTemporaryDoesNotTruncateHardlink() {
    Fixture fixture;
    wchar_t temp[MAX_PATH],dir[MAX_PATH],source[MAX_PATH],alias[MAX_PATH];
    CHECK(GetTempPathW(MAX_PATH,temp)>0);
    CHECK(GetTempFileNameW(temp,L"dky",0,dir));
    CHECK(DeleteFileW(dir));CHECK(CreateDirectoryW(dir,NULL));
    wcscpy(g_parentDirectory,dir);
    CHECK(JoinPath(source,L"user.txt"));CHECK(JoinPath(alias,L"decky_optiscaler_live.status.tmp"));
    CHECK(JoinPath(g_statusPath,L"decky_optiscaler_live.status"));
    HANDLE file=CreateFileW(source,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
    CHECK(file!=INVALID_HANDLE_VALUE);DWORD written=0;
    CHECK(WriteFile(file,"user",4,&written,NULL));CloseHandle(file);
    CHECK(CreateHardLinkW(alias,source,NULL));
    g_snapshot=fixture.SnapshotNow();WriteStatus();
    file=CreateFileW(source,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    CHECK(file!=INVALID_HANDLE_VALUE);char bytes[5]={};DWORD read=0;
    CHECK(ReadFile(file,bytes,4,&read,NULL)&&read==4&&!strcmp(bytes,"user"));CloseHandle(file);
    CHECK(DeleteFileW(source));CHECK(DeleteFileW(g_statusPath));CHECK(RemoveDirectoryW(dir));
    g_parentDirectory[0]=g_statusPath[0]=0;
}

static void TestBootstrapCallerFingerprint() {
    BYTE* image = static_cast<BYTE*>(VirtualAlloc(
        NULL, pe_size_of_image, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE));
    CHECK(image != nullptr);
    if (!image) return;
    BYTE* oldBase = g_coreBase;
    HMODULE oldCore = g_core;
    DWORD oldSize = g_coreImageSize;
    bool oldValid = g_coreValid;
    SectionRange oldSections[kMaxSections];
    size_t oldSectionCount = g_dataSectionCount;
    memcpy(oldSections, g_dataSections, sizeof(oldSections));

    g_coreBase = image;
    g_core = reinterpret_cast<HMODULE>(image);
    g_coreImageSize = pe_size_of_image;
    g_coreValid = true;
    g_dataSectionCount = 0;
    memcpy(image + bootstrap_return_rva - sizeof(bootstrap_call_before_return),
           bootstrap_call_before_return, sizeof(bootstrap_call_before_return));
    memcpy(image + bootstrap_return_rva, bootstrap_return_prologue,
           sizeof(bootstrap_return_prologue));
    CHECK(BootstrapCallerMatches(reinterpret_cast<uintptr_t>(image) + bootstrap_return_rva));
    CHECK(!BootstrapCallerMatches(reinterpret_cast<uintptr_t>(image) + bootstrap_return_rva + 1));
    image[bootstrap_return_rva - 1] ^= 1;
    CHECK(!BootstrapCallerMatches(reinterpret_cast<uintptr_t>(image) + bootstrap_return_rva));
    image[bootstrap_return_rva - 1] ^= 1;
    image[bootstrap_return_rva] ^= 1;
    CHECK(!BootstrapCallerMatches(reinterpret_cast<uintptr_t>(image) + bootstrap_return_rva));

    g_coreBase = oldBase;
    g_core = oldCore;
    g_coreImageSize = oldSize;
    g_coreValid = oldValid;
    g_dataSectionCount = oldSectionCount;
    memcpy(g_dataSections, oldSections, sizeof(oldSections));
    VirtualFree(image, 0, MEM_RELEASE);
}

static void TestSha256() {
    Sha256 hash;
    BYTE digest[32];
    Sha256Init(&hash);
    Sha256Update(&hash, reinterpret_cast<const BYTE*>("abc"), 3);
    Sha256Final(&hash, digest);
    static const BYTE expected[32] = {
        0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
        0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
        0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
        0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad
    };
    CHECK(BytesEqual(digest, expected, sizeof(expected)));
}

int main(int argc, char** argv) {
    TestBootstrapCallerFingerprint();
    TestStatusTemporaryDoesNotTruncateHardlink();
    TestSha256();
    TestProtocol();
    TestAllMenuOperations();
    TestBackendAcknowledgesOnlyConfiguration();
    TestMenuSideEffectsAndInactiveFGOptions();
    TestFgRuntimeActivity();
    TestSelectionAndDirectoryRejection();
    TestMailboxAndCallback();
    TestNoCallbackReleasesMailbox();
    int n = snprintf(report + reportUsed, sizeof(report) - reportUsed,
                     "%u passed, %u failed\n", passed, failed);
    if (n > 0 && static_cast<size_t>(n) < sizeof(report) - reportUsed)
        reportUsed += static_cast<size_t>(n);
    fwrite(report, 1, reportUsed, stdout);
    if (argc > 1) {
        HANDLE file = CreateFileA(argv[1], GENERIC_WRITE, FILE_SHARE_READ, NULL,
                                  CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file == INVALID_HANDLE_VALUE) return 2;
        DWORD written = 0;
        ::BOOL ok = WriteFile(file, report, static_cast<DWORD>(reportUsed), &written, NULL);
        CloseHandle(file);
        if (!ok || written != reportUsed) return 2;
    }
    return failed ? 1 : 0;
}
