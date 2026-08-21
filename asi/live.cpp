// Decky OptiScaler live-control ASI plugin.
//
// OptiScaler reads most of its settings once, at startup, and its in-game
// overlay changes them live only because the overlay *is* the game process: it
// writes straight into Config::Instance() and pokes a couple of State flags.
// There is no IPC, no config-reload hook, and ASI plugins are handed no API --
// OptiScaler simply LoadLibrary's each .asi and calls InitializeASI().
//
// So this plugin does from inside the process exactly what the overlay does:
//
//   * frame generation: Config::FGEnabled is consulted per frame by the
//     swapchain and FG dispatch paths, so flipping that bool is the whole
//     toggle.
//   * upscaler: FeatureProvider_*::ChangeFeature() rebuilds the feature from
//     State::newBackend as soon as State::changeBackend[handle] is true, and
//     writes the id it settled on back into Config itself. Putting an id in
//     that string and marking every entry of that map is precisely what the
//     overlay's "Change Upscaler" button does -- Config is not written by
//     either of us, because ChangeFeature falls back to Config's value when
//     newBackend is empty and would then have nothing to change to.
//
// Finding those two objects without symbols is the interesting part, and it is
// done by evidence rather than by hardcoded addresses -- see FindConfig() and
// FindState(). Nothing is written until every validation check passes; if any
// fails the plugin reports why in its status file and stays inert.

#define __USE_MINGW_ANSI_STDIO 1

#include <windows.h>
#include <psapi.h>

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "msvc_abi.h"
#include "generated/config_mirror.h"

using namespace optimirror;

// Field kind tags used by the generated table.
enum FieldKind { OPTI_BOOL, OPTI_I32, OPTI_U32, OPTI_U8, OPTI_FLOAT, OPTI_STR, OPTI_WSTR };

struct FieldDesc {
    const char* name;
    unsigned offset;
    unsigned kind;
};

#define FIELD_ENTRY(NAME, TYPE, KIND) { #NAME, (unsigned) offsetof(Config, NAME), KIND },
static const FieldDesc kFields[] = { OPTI_CONFIG_FIELDS(FIELD_ENTRY) };
#undef FIELD_ENTRY
static const size_t kFieldCount = sizeof(kFields) / sizeof(kFields[0]);

// ---------------------------------------------------------------- logging --

static wchar_t g_dir[MAX_PATH];       // folder holding OptiScaler.dll
static wchar_t g_logPath[MAX_PATH];
static wchar_t g_cmdPath[MAX_PATH];
static wchar_t g_statusPath[MAX_PATH];

static void LogLine(const char* fmt, ...) {
    if (!g_logPath[0]) return;
    HANDLE h = CreateFileW(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    char buf[1024];
    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(buf, sizeof(buf) - 2, fmt, args);
    va_end(args);
    if (n < 0) n = 0;
    buf[n++] = '\n';
    DWORD written = 0;
    SetFilePointer(h, 0, NULL, FILE_END);
    WriteFile(h, buf, (DWORD) n, &written, NULL);
    CloseHandle(h);
}

/** Best-effort ASCII copy of a wide string, for logging paths. */
static void NarrowCopy(char* out, size_t outLen, const wchar_t* in) {
    size_t i = 0;
    for (; in[i] && i + 1 < outLen; i++)
        out[i] = (in[i] < 0x80) ? (char) in[i] : '?';
    out[i] = 0;
}

// ------------------------------------------------------- memory safety net --

// Every candidate address comes from scanning, so each dereference is checked
// against the actual page protection first. A miss here is expected, not an
// error: it just means this candidate was not the object we are looking for.
// Scans are sequential, so a one-entry cache of the last region answers the
// overwhelming majority of queries without a syscall.
// Only used while scanning: a cached region could be decommitted afterwards,
// and the steady-state write path must never trust a stale answer.
static bool g_cacheEnabled = false;
static const unsigned char* g_cacheBase = NULL;
static size_t g_cacheSize = 0;
static bool g_cacheOk = false;

static bool QueryRegion(const unsigned char* p, MEMORY_BASIC_INFORMATION* mbi) {
    return VirtualQuery(p, mbi, sizeof(*mbi)) == sizeof(*mbi);
}

static bool Readable(const void* p, size_t len) {
    if (!p || len == 0) return false;
    const unsigned char* cur = (const unsigned char*) p;
    const unsigned char* end = cur + len;
    if (g_cacheEnabled && g_cacheBase && cur >= g_cacheBase && end <= g_cacheBase + g_cacheSize)
        return g_cacheOk;
    while (cur < end) {
        MEMORY_BASIC_INFORMATION mbi;
        if (!QueryRegion(cur, &mbi)) return false;
        if (mbi.State != MEM_COMMIT) return false;
        DWORD ok = PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READ |
                   PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
        if (!(mbi.Protect & ok)) return false;
        if (mbi.Protect & PAGE_GUARD) return false;
        if (g_cacheEnabled) {
            g_cacheBase = (const unsigned char*) mbi.BaseAddress;
            g_cacheSize = mbi.RegionSize;
            g_cacheOk = true;
        }
        cur = (const unsigned char*) mbi.BaseAddress + mbi.RegionSize;
    }
    return true;
}

static bool Writable(const void* p, size_t len) {
    if (!p || len == 0) return false;
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery(p, &mbi, sizeof(mbi)) != sizeof(mbi)) return false;
    if (mbi.State != MEM_COMMIT) return false;
    DWORD ok = PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
    return (mbi.Protect & ok) && !(mbi.Protect & PAGE_GUARD) &&
           (const unsigned char*) p + len <= (const unsigned char*) mbi.BaseAddress + mbi.RegionSize;
}

/** Copy a MSVC std::string out of the target process, or fail. */
static bool ReadStdString(const msvc_string* s, char* out, size_t outLen) {
    if (!Readable(s, sizeof(*s))) return false;
    if (s->capacity < s->size || s->size > 0x10000) return false;
    const char* data = s->capacity <= 15 ? s->bx.buf : s->bx.ptr;
    if (!Readable(data, s->size + 1)) return false;
    if (s->size >= outLen) return false;
    memcpy(out, data, s->size);
    out[s->size] = 0;
    return strlen(out) == s->size;
}

/** Copy a MSVC std::wstring out as UTF-16. */
static bool ReadStdWString(const msvc_wstring* s, wchar16* out, size_t outLen) {
    if (!Readable(s, sizeof(*s))) return false;
    if (s->capacity < s->size || s->size > 0x8000) return false;
    const wchar16* data = s->capacity <= 7 ? s->bx.buf : s->bx.ptr;
    if (!Readable(data, (s->size + 1) * sizeof(wchar16))) return false;
    if (s->size >= outLen) return false;
    memcpy(out, data, s->size * sizeof(wchar16));
    out[s->size] = 0;
    return true;
}

static bool WideEqualsAscii(const wchar16* w, const char* ascii) {
    for (; *ascii; ++ascii, ++w)
        if (*w != (wchar16) (unsigned char) *ascii) return false;
    return *w == 0;
}

static bool WideEndsWithAsciiNoCase(const wchar16* w, const char* suffix) {
    size_t wl = 0, sl = strlen(suffix);
    while (w[wl]) wl++;
    if (wl < sl) return false;
    const wchar16* tail = w + (wl - sl);
    for (size_t i = 0; i < sl; i++) {
        int a = tail[i], b = (unsigned char) suffix[i];
        if (a >= 'A' && a <= 'Z') a += 32;
        if (b >= 'A' && b <= 'Z') b += 32;
        if (a != b) return false;
    }
    return true;
}

/** Enables the region cache for the duration of one scan. */
struct ScopedScanCache {
    ScopedScanCache() { g_cacheEnabled = true; g_cacheBase = NULL; g_cacheOk = false; }
    ~ScopedScanCache() { g_cacheEnabled = false; g_cacheBase = NULL; g_cacheOk = false; }
};

// ------------------------------------------------- OptiScaler module lookup --

/**
 * OptiScaler can be installed under any of a dozen proxy filenames, so it is
 * identified by what it exports rather than by name: it is the only module that
 * exports both an NVNGX entry point and the wininet AppCache surface.
 */
static HMODULE FindOptiScalerModule() {
    HMODULE mods[1024];
    DWORD needed = 0;
    if (!EnumProcessModules(GetCurrentProcess(), mods, sizeof(mods), &needed)) return NULL;
    size_t count = needed / sizeof(HMODULE);
    for (size_t i = 0; i < count; i++) {
        if (GetProcAddress(mods[i], "NVSDK_NGX_D3D12_Init") &&
            GetProcAddress(mods[i], "AppCacheCheckManifest"))
            return mods[i];
    }
    return NULL;
}

struct Section {
    unsigned char* base;
    size_t size;
};

/** Writable data sections of a module -- where its statics live. */
static int ModuleDataSections(HMODULE mod, Section* out, int maxOut) {
    unsigned char* base = (unsigned char*) mod;
    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*) base;
    if (!Readable(dos, sizeof(*dos)) || dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    IMAGE_NT_HEADERS* nt = (IMAGE_NT_HEADERS*) (base + dos->e_lfanew);
    if (!Readable(nt, sizeof(*nt)) || nt->Signature != IMAGE_NT_SIGNATURE) return 0;
    IMAGE_SECTION_HEADER* sec = IMAGE_FIRST_SECTION(nt);
    int found = 0;
    for (int i = 0; i < nt->FileHeader.NumberOfSections && found < maxOut; i++) {
        if (!(sec[i].Characteristics & IMAGE_SCN_MEM_WRITE)) continue;
        if (sec[i].Characteristics & IMAGE_SCN_MEM_EXECUTE) continue;
        size_t size = sec[i].Misc.VirtualSize ? sec[i].Misc.VirtualSize : sec[i].SizeOfRawData;
        if (!size) continue;
        out[found].base = base + sec[i].VirtualAddress;
        out[found].size = size;
        found++;
    }
    return found;
}

// ------------------------------------------------------------ Config lookup --

// Config is heap-allocated (`_config = new Config()`), and `_config` itself is
// a static in OptiScaler's data section. So: walk the data sections looking for
// a pointer whose target validates as a Config.
//
// Validation uses values we can predict without reading anything of Steam's:
// the last two members are the absolute path of OptiScaler.ini and the literal
// filename, and several options carry compile-time defaults (the overlay
// hotkeys, font size, sharpness). Those checks are spread from the middle of
// the struct to its end, so any mis-parsed member would break at least one.

static bool LooksLikeConfig(const Config* cfg) {
    if (!Readable(cfg, sizeof(Config))) return false;

    wchar16 buf[MAX_PATH];
    if (!ReadStdWString(&cfg->fileName, buf, MAX_PATH)) return false;
    if (!WideEqualsAscii(buf, "OptiScaler.ini")) return false;

    if (!ReadStdWString(&cfg->absoluteFileName.text, buf, MAX_PATH)) return false;
    if (!WideEndsWithAsciiNoCase(buf, "OptiScaler.ini")) return false;

    // Compile-time defaults, sampled across the struct.
    if (cfg->ShortcutKey.defaultValue != VK_INSERT) return false;
    if (cfg->FpsShortcutKey.defaultValue != VK_PRIOR) return false;
    if (cfg->FGShortcutKey.defaultValue != VK_END) return false;
    if (cfg->FontSize.defaultValue != 14.0f) return false;
    if (cfg->Sharpness.defaultValue != 0.4f) return false;
    if (cfg->DlssReactiveMaskBias.defaultValue != 0.45f) return false;
    return true;
}

static Config* FindConfig(HMODULE opti) {
    ScopedScanCache cache;
    Section sections[16];
    int n = ModuleDataSections(opti, sections, 16);
    for (int s = 0; s < n; s++) {
        unsigned char* p = sections[s].base;
        unsigned char* end = p + sections[s].size;
        // _config is a pointer, so it is pointer-aligned within the section.
        p = (unsigned char*) (((uintptr_t) p + 7) & ~(uintptr_t) 7);
        for (; p + sizeof(void*) <= end; p += sizeof(void*)) {
            if (!Readable(p, sizeof(void*))) continue;
            Config* candidate = *(Config**) p;
            uintptr_t address = (uintptr_t) candidate;
            if (address < 0x10000 || address > 0x7FFFFFFFFFFFull) continue;
            if (address & 0xF) continue;  // operator new is 16-byte aligned
            if (LooksLikeConfig(candidate)) return candidate;
        }
    }
    return NULL;
}

// ------------------------------------------------------------- State lookup --

// State is a function-local static, so it lives in OptiScaler's data section
// rather than the heap, and its first three members are std::strings holding
// the running executable's filename, the detected game name and its version.
// The executable filename is something this plugin can compute for itself, so
// that string is the anchor.

struct StateLoc {
    unsigned char* base;
    size_t window;
};

static bool FindState(HMODULE opti, const char* exeName, StateLoc* out) {
    ScopedScanCache cache;
    Section sections[16];
    int n = ModuleDataSections(opti, sections, 16);
    for (int s = 0; s < n; s++) {
        unsigned char* p = sections[s].base;
        unsigned char* end = p + sections[s].size;
        p = (unsigned char*) (((uintptr_t) p + 7) & ~(uintptr_t) 7);
        for (; p + sizeof(msvc_string) * 3 <= end; p += 8) {
            char name[MAX_PATH];
            if (!ReadStdString((const msvc_string*) p, name, sizeof(name))) continue;
            if (_stricmp(name, exeName) != 0) continue;
            // gameName and gameVersion must at least decode as strings.
            char scratch[MAX_PATH];
            if (!ReadStdString((const msvc_string*) (p + sizeof(msvc_string)), scratch, sizeof(scratch)))
                continue;
            if (!ReadStdString((const msvc_string*) (p + sizeof(msvc_string) * 2), scratch, sizeof(scratch)))
                continue;
            out->base = p;
            out->window = (size_t) (end - p);
            if (out->window > 8192) out->window = 8192;
            return true;
        }
    }
    return false;
}

// ------------------------------------------- changeBackend / newBackend --

// State declares the pair this plugin needs together, under its own
// "// for realtime changes" comment:
//
//     ankerl::unordered_dense::map<unsigned int, bool> changeBackend;
//     std::string newBackend = "";
//
// so finding the map finds both. The map is not a pointer to anything: the
// table object is a member of the State singleton, which is why its address
// stays valid for the life of the process even as it rehashes.
//
// unordered_dense's table is laid out below rather than pattern-matched,
// because guessing cost this plugin its entire upscaler switch once already.
// The first version looked for "a vector-shaped triple with 0.8f somewhere in
// the next 80 bytes" and kept the last hit -- but m_buckets is *also* a vector,
// it also sits within 80 bytes of the load factor, and it comes later. Every
// run therefore latched onto m_buckets, newBackend was hunted for 24 bytes past
// where it lives, never validated, and the plugin reported "newBackend not
// located" for ever: frame generation kept working, the upscaler never moved.
//
// Both offsets now come from the compiler, and every check is at an exact
// offset, so a shifted window cannot match at all.

/**
 * ankerl::unordered_dense::map<unsigned int, bool>, MSVC x64.
 *
 * From external/unordered_dense (the submodule OptiScaler pins), class
 * detail::table: an empty base for the map's mapped_type typedef, then
 *
 *     value_container_type m_values;      // std::vector<std::pair<K, V>>
 *     bucket_container_type m_buckets;    // std::vector<Bucket>
 *     size_t m_max_bucket_capacity;
 *     float m_max_load_factor;            // default_max_load_factor, 0.8f
 *     Hash m_hash;                        // empty, but still one byte each
 *     KeyEqual m_equal;
 *     uint8_t m_shifts;                   // initial_shifts, 64 - 2
 */
struct ud_table {
    msvc_vector_raw m_values;
    msvc_vector_raw m_buckets;
    size_t m_max_bucket_capacity;
    float m_max_load_factor;
    unsigned char m_hash;
    unsigned char m_equal;
    unsigned char m_shifts;
};

/** std::pair<unsigned int, bool>: the map's element, and what the overlay walks. */
struct backend_entry {
    unsigned int handle;
    unsigned char changed;
    unsigned char pad[3];
};

/** bucket_type::standard, the default Bucket -- two uint32s. */
struct ud_bucket {
    uint32_t dist_and_fingerprint;
    uint32_t value_idx;
};

static const float kMaxLoadFactor = 0.8f;
static const unsigned char kInitialShifts = 64 - 2;

// The layout above is the whole basis for both writes, so make the compiler
// check it rather than trusting the comment.
static_assert(sizeof(backend_entry) == 8, "std::pair<unsigned,bool> is 8 bytes on MSVC x64");
static_assert(offsetof(backend_entry, changed) == 4, "the bool follows the key at +4");
static_assert(sizeof(ud_bucket) == 8, "bucket_type::standard is two uint32s");
static_assert(offsetof(ud_table, m_buckets) == 24, "m_buckets follows the value vector");
static_assert(offsetof(ud_table, m_max_bucket_capacity) == 48, "unexpected table layout");
static_assert(offsetof(ud_table, m_max_load_factor) == 56, "unexpected table layout");
static_assert(offsetof(ud_table, m_shifts) == 62, "unexpected table layout");
static_assert(sizeof(ud_table) == 64, "the table must be 64 bytes for newBackend to be at +64");

struct BackendMap {
    ud_table* table;
    msvc_string* newBackend;  // State::newBackend, declared right after the map
};

/** How many buckets a given shift count means; the table's calc_num_buckets. */
static size_t BucketsForShifts(unsigned char shifts) {
    if (shifts < 1 || shifts > 63) return 0;
    return (size_t) 1 << (64 - shifts);
}

/**
 * A std::vector<T> whose contents are readable, or "never used" (all null).
 * Returns the element count.
 */
static bool VectorOfStride(const msvc_vector_raw* v, size_t stride, size_t* countOut) {
    if (!Readable(v, sizeof(*v))) return false;
    unsigned char* first = (unsigned char*) v->first;
    unsigned char* last = (unsigned char*) v->last;
    unsigned char* end = (unsigned char*) v->end;
    if (!first && !last && !end) { *countOut = 0; return true; }
    if (!first || last < first || end < last) return false;
    size_t usedBytes = (size_t) (last - first);
    size_t capBytes = (size_t) (end - first);
    if (usedBytes % stride || capBytes % stride) return false;
    if (capBytes > stride * 4096) return false;
    if (!Readable(first, capBytes ? capBytes : stride)) return false;
    *countOut = usedBytes / stride;
    return true;
}

// The backend ids OptiScaler accepts (OptiScaler/menu/menu_common.cpp, the
// AddDx11/Dx12/VulkanBackends combos).
static const char* kBackendCodes[] = { "xess",  "xess_12", "fsr21", "fsr21_12", "fsr22",
                                       "fsr22_12", "fsr31", "fsr31_12", "dlss", "dlssd" };

static bool IsBackendCode(const char* code) {
    for (size_t i = 0; i < sizeof(kBackendCodes) / sizeof(kBackendCodes[0]); i++)
        if (strcmp(kBackendCodes[i], code) == 0) return true;
    return false;
}

/**
 * Whether the string one table past a candidate really is State::newBackend.
 *
 * This is the check that separates changeBackend from the two other
 * unordered_dense maps State holds (DeviceAdapterNames and CapturedHudlesses),
 * which are identical as tables and differ only in what follows them.
 * OptiScaler leaves this string empty between switches and otherwise puts one
 * of its own backend ids in it, and it is short enough never to leave the small
 * string buffer -- so the capacity is the inline one.
 */
static bool LooksLikeNewBackend(const msvc_string* s) {
    char text[64];
    if (!ReadStdString(s, text, sizeof(text))) return false;
    if (s->capacity < 15) return false;
    return text[0] == 0 || IsBackendCode(text);
}

/**
 * Whether every element decodes as a std::pair<unsigned int, bool>.
 *
 * The bool is the byte the overlay writes, so a container whose "bools" are not
 * bools is one this plugin must not touch.
 */
static bool EntriesLookLikePairs(const msvc_vector_raw* values, size_t count) {
    const backend_entry* entries = (const backend_entry*) values->first;
    for (size_t i = 0; i < count; i++)
        if (entries[i].changed > 1) return false;
    return true;
}

/**
 * Everything that is true of an unordered_dense table whatever it holds.
 *
 * State has three of them and this plugin now needs two, so the invariants live
 * here once: the load factor and shift count at their exact offsets, the bucket
 * vector agreeing with both, and a value vector whose length is a whole number
 * of elements of the caller's stride. What tells one table from another is
 * never in here -- that is the caller's job, and it is what the checks below
 * exist to do.
 *
 * ``countOut`` receives the element count, so the caller can validate the
 * elements themselves.
 */
static bool TableInvariantsHold(const ud_table* t, size_t valueStride, size_t maxCount,
                                size_t* countOut) {
    if (!Readable(t, sizeof(ud_table))) return false;

    // Exact offsets, so a window shifted by a word cannot match by accident.
    if (t->m_max_load_factor != kMaxLoadFactor) return false;
    if (t->m_shifts < 1 || t->m_shifts > kInitialShifts) return false;

    size_t bucketCount = 0;
    if (!VectorOfStride(&t->m_buckets, sizeof(ud_bucket), &bucketCount)) return false;
    if (bucketCount == 0) {
        // Never inserted into: no buckets allocated and no capacity claimed.
        if (t->m_max_bucket_capacity != 0) return false;
    } else {
        if (bucketCount != BucketsForShifts(t->m_shifts)) return false;
        if (t->m_max_bucket_capacity !=
            (size_t) ((float) bucketCount * kMaxLoadFactor)) return false;
    }

    size_t count = 0;
    if (!VectorOfStride(&t->m_values, valueStride, &count)) return false;
    if (count > maxCount) return false;
    if (count > t->m_max_bucket_capacity) return false;
    *countOut = count;
    return true;
}

/** Full validation of one candidate address as State::changeBackend. */
static bool LooksLikeChangeBackend(const ud_table* t) {
    if (!Readable(t, sizeof(ud_table) + sizeof(msvc_string))) return false;

    size_t count = 0;
    if (!TableInvariantsHold(t, sizeof(backend_entry), 256, &count)) return false;
    if (count && !EntriesLookLikePairs(&t->m_values, count)) return false;

    return LooksLikeNewBackend((const msvc_string*) (t + 1));
}

/**
 * Locate State::changeBackend, and with it State::newBackend.
 *
 * State holds three unordered_dense maps -- DeviceAdapterNames,
 * CapturedHudlesses and changeBackend, in that declaration order -- and they
 * are indistinguishable as tables. What tells them apart is what follows:
 * only changeBackend is followed by a std::string holding a backend id. That,
 * plus keeping the last candidate to break a tie in declaration order, is
 * enough; every check fails closed, so a State this does not recognise leaves
 * upscaler switching reported as unavailable rather than writing blind.
 */
static bool FindChangeBackend(const StateLoc* state, BackendMap* out) {
    unsigned char* p = state->base;
    unsigned char* end = p + state->window;
    bool found = false;
    for (; p + sizeof(ud_table) + sizeof(msvc_string) <= end; p += 8) {
        ud_table* candidate = (ud_table*) p;
        if (!LooksLikeChangeBackend(candidate)) continue;
        out->table = candidate;
        out->newBackend = (msvc_string*) (candidate + 1);
        found = true;
    }
    if (found)
        LogLine("changeBackend at +%lu of State, newBackend at +%lu",
                (unsigned long) ((unsigned char*) out->table - state->base),
                (unsigned long) ((unsigned char*) out->newBackend - state->base));
    return found;
}

// -------------------------------------------------------- frame counter --

/**
 * State::frameCount is declared immediately before State::changeBackend, so it
 * is the eight bytes in front of the map already located. Sampling it between
 * heartbeats is how this plugin reports frame rate without being in the render
 * loop itself.
 *
 * A wrong guess here is harmless-but-useless rather than dangerous: the counter
 * is only ever read, never written, and a candidate that runs backwards or
 * absurdly fast is rejected.
 */
static uint64_t* FindFrameCount(const BackendMap* map) {
    if (!map->table) return NULL;
    uint64_t* candidate = (uint64_t*) ((unsigned char*) map->table - 8);
    if (!Readable(candidate, sizeof(uint64_t))) return NULL;
    return candidate;
}

// ------------------------------------ FG restart flags / FFX FG versions --

// OptiScaler's overlay changes the frame generator the same way it changes the
// upscaler: it writes the choice into Config and then raises two flags in State
// that the FG dispatch path watches. Its "Change FG" button, in full, is
//
//     config->FfxFGIndex = _ffxFGIndex;
//     state.FGchanged = true;
//     state.SCchanged = true;
//
// and FSRFG_Dx12::Dispatch acts on it the next frame: FGchanged deactivates the
// generator, SCchanged destroys its context, and CreateContext then runs again
// and re-reads FfxFGIndex. Both flags are needed. Writing the index alone
// leaves it sitting in Config, and toggling frame generation off and on does
// not stand in for them either -- the context is not destroyed when FG is
// merely disabled, only when SCchanged says so.
//
// Neither flag is a pointer and neither is next to anything with a distinctive
// value, so they are located the way everything else here is: relative to an
// object that can be identified. State::CapturedHudlesses is another
// unordered_dense table; the compiler works out that it is declared 21 bytes
// past FGchanged, and it is the only such table between DeviceAdapterNames
// (which is at a computed offset from State's first member) and changeBackend
// (already located). What confirms it is what follows it -- a bool, the NVNGX
// application id, a wstring and a string, each at an exact offset. If two
// candidates pass, or any check fails, the flags stay unlocated and the FFX FG
// switch reports itself unavailable rather than writing a byte into State on
// the strength of a guess.

/** State's first members, which put DeviceAdapterNames at a computed offset. */
struct state_head {
    msvc_string GameExe;
    msvc_string GameName;
    msvc_string GameVersion;
    uint32_t GameEngine;  // GameEngineType
    ud_table DeviceAdapterNames;
};

static_assert(offsetof(state_head, DeviceAdapterNames) == 104,
              "State's three leading strings and its engine enum put the first map at +104");

/** std::pair<void*, CapturedHudlessInfo>, the element CapturedHudlesses holds. */
struct hudless_entry {
    void* key;
    uint64_t usageCount;
    uint32_t captureInfo;
    unsigned char enabled;
    unsigned char pad[3];
};

static_assert(sizeof(hudless_entry) == 24, "captured_hudless_info pairs are 24 bytes");

/**
 * State, from the frame-generation bools through the members that identify
 * CapturedHudlesses.
 *
 * Declaration order is layout order, so mirroring the run gives the compiler
 * everything it needs to say how far in front of the table FGchanged sits.
 * Every type in the run is one this plugin knows the exact size of; nothing
 * here is measured by hand.
 */
struct state_fg_block {
    bool FGPresentIsCalled;
    bool FGonlyGenerated;
    bool FGHudlessCompare;
    bool FGchanged;
    bool SCchanged;
    bool skipHeapCapture;
    bool FGcaptureResources;
    size_t FGcapturedResourceCount;
    bool FGresetCapturedResources;
    bool FGonlyUseCapturedResources;
    bool FSRFGFTPchanged;
    bool FSRFGInputActive;
    bool FGResizing;
    ud_table CapturedHudlesses;
    bool ClearCapturedHudlesses;
    uint64_t NVNGX_ApplicationId;
    msvc_wstring NVNGX_ApplicationDataPath;
    msvc_string NVNGX_ProjectId;
};

/** Where a member of that run sits relative to the table this plugin can find. */
#define FG_BLOCK_OFF(member)                             \
    ((ptrdiff_t) offsetof(state_fg_block, member) -      \
     (ptrdiff_t) offsetof(state_fg_block, CapturedHudlesses))

static_assert(FG_BLOCK_OFF(FGchanged) == -21, "FGchanged is 21 bytes in front of the table");
static_assert(FG_BLOCK_OFF(SCchanged) == -20, "SCchanged is declared straight after FGchanged");
static_assert(FG_BLOCK_OFF(ClearCapturedHudlesses) == 64, "the bool follows the table");
static_assert(FG_BLOCK_OFF(NVNGX_ApplicationId) == 72, "the application id confirms the table");

/**
 * State, from changeBackend to the frame times OptiScaler keeps for its own
 * overlay. Same trick as above, in the other direction: every type in the run
 * is fixed width, so everything in it is at an offset the compiler computes
 * from the map rather than one this plugin goes looking for.
 *
 * The run reaches three things: the two FFX version lists (which turn an index
 * into a name), and the pair of frame-interval measurements that separate the
 * rendered frame rate from the presented one.
 */
struct state_tail {
    ud_table changeBackend;
    msvc_string newBackend;
    bool xessDebug;
    int32_t xessDebugFrames;
    float lastMipBias;
    float lastMipBiasMax;
    int32_t xefgMaxInterpolationCount;
    bool WAR_xefgRequestFGToggle;
    bool dlssPresetsOverriddenExternally;
    bool dlssPresetsOverridenByOpti;
    uint32_t dlssRenderPresetExternal;
    uint32_t dlssRenderPresetDLAA;
    uint32_t dlssRenderPresetUltraQuality;
    uint32_t dlssRenderPresetQuality;
    uint32_t dlssRenderPresetBalanced;
    uint32_t dlssRenderPresetPerformance;
    uint32_t dlssRenderPresetUltraPerformance;
    bool dlssdPresetsOverriddenExternally;
    bool dlssdPresetsOverridenByOpti;
    uint32_t dlssdRenderPresetExternal;
    uint32_t dlssdRenderPresetDLAA;
    uint32_t dlssdRenderPresetUltraQuality;
    uint32_t dlssdRenderPresetQuality;
    uint32_t dlssdRenderPresetBalanced;
    uint32_t dlssdRenderPresetPerformance;
    uint32_t dlssdRenderPresetUltraPerformance;
    bool skipSpoofing;
    bool skipDxgiLoadChecks;
    bool skipParentWrapping;
    msvc_vector_raw detectedQuirks;
    msvc_vector_raw ffxUpscalerVersionNames;
    msvc_vector_raw ffxUpscalerVersionIds;
    msvc_vector_raw ffxFGVersionNames;
    msvc_vector_raw ffxFGVersionIds;
    msvc_optional<uint32_t> currentFsr4Preset;
    bool isRunningOnLinux;
    bool isRunningOnDXVK;
    bool isRunningOnNvidia;
    msvc_optional<bool> isRunningOnRDNA4;
    msvc_optional<bool> isRunningOnRDNA3;
    bool isPascalOrOlder;
    uint32_t workingMode;  // WorkingMode
    bool vulkanCreatingSC;
    bool creatingD3DDevice;
    bool vulkanSkipHooks;
    void* VulkanInstance;  // VkInstance, an opaque handle
    msvc_deque_raw upscaleTimes;
    msvc_deque_raw frameTimes;
    double lastFGFrameTime;
    double presentFrameTime;
};

static_assert(offsetof(state_tail, newBackend) == sizeof(ud_table),
              "the string this plugin already validates must still follow the map");
static_assert(offsetof(state_tail, ffxUpscalerVersionNames) == 208,
              "unexpected State tail layout");
static_assert(offsetof(state_tail, ffxFGVersionNames) == 256, "unexpected State tail layout");
static_assert(offsetof(state_tail, ffxFGVersionIds) ==
                  offsetof(state_tail, ffxFGVersionNames) + sizeof(msvc_vector_raw),
              "the ids vector is declared straight after the names vector");
static_assert(offsetof(state_tail, ffxUpscalerVersionIds) ==
                  offsetof(state_tail, ffxUpscalerVersionNames) + sizeof(msvc_vector_raw),
              "the upscaler ids vector is declared straight after its names vector");
static_assert(sizeof(msvc_deque_raw) == 32, "MSVC's deque is four words");
static_assert(offsetof(state_tail, lastFGFrameTime) == 400, "unexpected State tail layout");
static_assert(offsetof(state_tail, presentFrameTime) ==
                  offsetof(state_tail, lastFGFrameTime) + sizeof(double),
              "the present interval is declared straight after the rendered one");

/** Where the two flags OptiScaler's FG dispatch watches live, once identified. */
struct FgFlags {
    unsigned char* fgChanged;
    unsigned char* scChanged;
};

/** A std::string intact enough to have been one. Length is not the point. */
static bool LooksLikeStdString(const msvc_string* s) {
    if (!Readable(s, sizeof(*s))) return false;
    if (s->capacity < 15 || s->capacity < s->size || s->size > 0x10000) return false;
    const char* data = s->capacity <= 15 ? s->bx.buf : s->bx.ptr;
    return Readable(data, s->size + 1) && data[s->size] == 0;
}

/** The same, for the wide string MSVC lays out with an eight-character buffer. */
static bool LooksLikeStdWString(const msvc_wstring* s) {
    if (!Readable(s, sizeof(*s))) return false;
    if (s->capacity < 7 || s->capacity < s->size || s->size > 0x10000) return false;
    const wchar16* data = s->capacity <= 7 ? s->bx.buf : s->bx.ptr;
    return Readable(data, (s->size + 1) * sizeof(wchar16)) && data[s->size] == 0;
}

/**
 * Whether a candidate address is State::CapturedHudlesses.
 *
 * The table invariants alone cannot say -- they are true of all three of
 * State's maps. The four members declared after it can: a bool, an application
 * id OptiScaler defaults to 1337 and games overwrite with their own, and two
 * strings. All four are checked at exact offsets the compiler supplied.
 */
static bool LooksLikeCapturedHudlesses(const ud_table* t) {
    size_t count = 0;
    if (!TableInvariantsHold(t, sizeof(hudless_entry), 4096, &count)) return false;

    const hudless_entry* entries = (const hudless_entry*) t->m_values.first;
    for (size_t i = 0; i < count; i++) {
        // Every key is a resource pointer and every value ends in a bool.
        if (!entries[i].key || entries[i].enabled > 1) return false;
    }

    const unsigned char* at = (const unsigned char*) t;
    if (!Readable(at + FG_BLOCK_OFF(ClearCapturedHudlesses), 1)) return false;
    if (at[FG_BLOCK_OFF(ClearCapturedHudlesses)] > 1) return false;

    const uint64_t* appId = (const uint64_t*) (at + FG_BLOCK_OFF(NVNGX_ApplicationId));
    if (!Readable(appId, sizeof(*appId))) return false;
    if (*appId == 0 || *appId > ((uint64_t) 1 << 40)) return false;

    if (!LooksLikeStdWString((const msvc_wstring*) (at + FG_BLOCK_OFF(NVNGX_ApplicationDataPath))))
        return false;
    return LooksLikeStdString((const msvc_string*) (at + FG_BLOCK_OFF(NVNGX_ProjectId)));
}

/**
 * Locate State::FGchanged and State::SCchanged.
 *
 * Bounded on both sides by objects already identified: the search starts past
 * DeviceAdapterNames, whose offset the compiler knows, and stops at
 * changeBackend, which the scan above found. Exactly one candidate has to
 * match -- two would mean the evidence does not identify the table, and this
 * writes into State, so ambiguity is a refusal rather than a coin toss.
 */
static bool FindFgFlags(const StateLoc* state, const BackendMap* map, FgFlags* out) {
    if (!state->base || !map->table) return false;
    ScopedScanCache cache;
    unsigned char* first =
        state->base + offsetof(state_head, DeviceAdapterNames) + sizeof(ud_table);
    unsigned char* last = (unsigned char*) map->table;
    if (last <= first) return false;

    unsigned char* found = NULL;
    int matches = 0;
    for (unsigned char* p = first; p + sizeof(ud_table) <= last; p += 8) {
        if (!LooksLikeCapturedHudlesses((const ud_table*) p)) continue;
        found = p;
        matches++;
    }
    if (matches != 1) {
        if (matches)
            LogLine("CapturedHudlesses is ambiguous (%d candidates); FG flags stay unlocated",
                    matches);
        return false;
    }

    unsigned char* fg = found + FG_BLOCK_OFF(FGchanged);
    unsigned char* sc = found + FG_BLOCK_OFF(SCchanged);
    // OptiScaler clears both every dispatch, so they are bools and usually 0.
    if (!Readable(fg, 2) || *fg > 1 || *sc > 1) return false;
    if (!Writable(fg, 2)) return false;
    out->fgChanged = fg;
    out->scChanged = sc;
    LogLine("CapturedHudlesses at +%lu of State; FGchanged at +%lu, SCchanged at +%lu",
            (unsigned long) (found - state->base), (unsigned long) (fg - state->base),
            (unsigned long) (sc - state->base));
    return true;
}

// The FFX SDK reports what it can offer this game -- both the frame generators
// and the upscaler versions -- and OptiScaler stores each list as two parallel
// vectors of names and ids. Config::FfxFGIndex and Config::FfxUpscalerIndex are
// indexes into them, so reading them is what turns "index 1" into something a
// user can be shown -- and what makes an index the running game does not have
// refusable rather than silently clamped to 0, which is what OptiScaler would
// do with it.
//
// The upscaler list is also the only place the exact FSR version is written
// down: FSR31Feature_Dx12::CreateContext parses its feature name straight out
// of ffxUpscalerVersionNames[FfxUpscalerIndex], which is why the overlay's
// title bar and its "FFX Upscaler" combo always agree.

#define FFX_FG_MAX 16
#define FFX_FG_NAME_MAX 32

/** Copy a NUL-terminated ASCII string out of the process, refusing anything else. */
static bool ReadCString(const char* s, char* out, size_t outLen) {
    size_t n = 0;
    while (n + 1 < outLen) {
        if (!Readable(s + n, 1)) return false;
        char ch = s[n];
        if (ch == 0) { out[n] = 0; return n > 0; }
        if (ch < 0x20 || ch > 0x7e) return false;
        out[n] = ch;
        n++;
    }
    return false;
}

/**
 * Read one of State's two FFX version lists, which are only populated once the
 * game has queried the SDK -- so "not yet" is a normal answer and not an error.
 *
 * Both lists have the same shape and the same relationship to the map already
 * located, so the offsets of the pair are the only thing that differs.
 */
static bool ReadFfxVersions(const BackendMap* map, size_t namesOffset, size_t idsOffset,
                            char names[FFX_FG_MAX][FFX_FG_NAME_MAX], int* countOut) {
    if (!map->table) return false;
    ScopedScanCache cache;
    const unsigned char* base = (const unsigned char*) map->table;
    const msvc_vector_raw* nameVec = (const msvc_vector_raw*) (base + namesOffset);
    const msvc_vector_raw* idVec = (const msvc_vector_raw*) (base + idsOffset);

    size_t nameCount = 0, idCount = 0;
    if (!VectorOfStride(nameVec, sizeof(const char*), &nameCount)) return false;
    if (!VectorOfStride(idVec, sizeof(uint64_t), &idCount)) return false;
    // The two are filled in together, so disagreement means this is not them.
    if (nameCount != idCount || nameCount == 0 || nameCount > FFX_FG_MAX) return false;

    const char* const* text = (const char* const*) nameVec->first;
    for (size_t i = 0; i < nameCount; i++)
        if (!ReadCString(text[i], names[i], FFX_FG_NAME_MAX)) return false;
    *countOut = (int) nameCount;
    return true;
}

/**
 * OptiScaler's own two frame-interval measurements, which is what separates the
 * rendered frame rate from the presented one.
 *
 * With frame generation running, the game holds the FidelityFX FG swapchain and
 * presents to it once per rendered frame; the FFX runtime then pushes both that
 * frame and the generated ones through the swapchain OptiScaler wraps. Each
 * side times itself:
 *
 *   State::lastFGFrameTime   set in FGHooks::FGPresent, once per *rendered*
 *                            frame -- and by the wrapped swapchain instead when
 *                            no frame generator exists, so with FG absent the
 *                            two simply agree.
 *   State::presentFrameTime  set in wrapped_swapchain's LocalPresent, once per
 *                            *presented* frame, generated ones included.
 *
 * Both are plain doubles inside State, at offsets the compiler computes from
 * the map above, and both are only ever read.
 */
struct FrameTimes {
    const double* rendered;   // State::lastFGFrameTime
    const double* presented;  // State::presentFrameTime
};

static bool FindFrameTimes(const BackendMap* map, FrameTimes* out) {
    if (!map->table) return false;
    const unsigned char* base = (const unsigned char*) map->table;
    const double* rendered = (const double*) (base + offsetof(state_tail, lastFGFrameTime));
    const double* presented = (const double*) (base + offsetof(state_tail, presentFrameTime));
    if (!Readable(rendered, sizeof(double) * 2)) return false;
    out->rendered = rendered;
    out->presented = presented;
    return true;
}

// ------------------------------------------------------------ apply actions --

static Config* g_config = NULL;
static StateLoc g_state = { NULL, 0 };
static BackendMap g_backends = { NULL, NULL };
static msvc_string* g_newBackend = NULL;
static uint64_t* g_frameCount = NULL;
static FgFlags g_fgFlags = { NULL, NULL };
static FrameTimes g_frameTimes = { NULL, NULL };
// The frame generators the FFX SDK reported to this game, in FfxFGIndex order.
static char g_ffxFgNames[FFX_FG_MAX][FFX_FG_NAME_MAX];
static int g_ffxFgCount = 0;
// The upscaler versions it reported, in FfxUpscalerIndex order. These are the
// exact FSR versions -- "4.1.1", "3.1.5" -- that OptiScaler's overlay shows.
static char g_ffxUpscalerNames[FFX_FG_MAX][FFX_FG_NAME_MAX];
static int g_ffxUpscalerCount = 0;
// Exponentially smoothed copies of the two intervals above, in milliseconds.
// Each is the last frame's delta rather than an average, so a single reading is
// as noisy as one frame; the panel wants a number that holds still.
static double g_renderedMs = 0.0;
static double g_presentedMs = 0.0;
static uint64_t g_lastFrames = 0;
static DWORD g_lastFrameTick = 0;
static double g_fps = 0.0;
static uint64_t g_framesSeen = 0;
static char g_error[256] = "";
static long g_seq = -1;
static int g_lastApplied = 0;

// ------------------------------------------------- frame counter, part two --

// FindFrameCount above only knows where frameCount is *declared*. Whether the
// running build actually increments it is a different question, and one that
// cost a permanently "measuring" frame rate the first time round: when that
// slot never moves there is nothing to distinguish it from a game stuck at
// zero frames per second.
//
// So the declared slot is a first guess, and if it does not move the plugin
// goes looking for one that does: an eight-byte word inside State that climbs
// at a plausible frame rate across two consecutive intervals. This is read-only
// from start to finish -- the worst a wrong guess can do is report a number
// that is not the frame rate, which the rate window below makes unlikely, and
// the search gives up rather than settling for a weak match.

#define FC_MAX_SLOTS 1024
#define FC_MAX_CANDIDATES 12
#define FC_MAX_ROUNDS 8

static uint64_t g_fcSnapshot[FC_MAX_SLOTS];
static int g_fcSlotCount = 0;
static DWORD g_fcSnapshotTick = 0;
static int g_fcPhase = 0;  // 0: take a snapshot, 1: first delta, 2: confirm
static int g_fcCandidates[FC_MAX_CANDIDATES];
static double g_fcRates[FC_MAX_CANDIDATES];
static int g_fcCandidateCount = 0;
static int g_fcRounds = 0;
static bool g_fcDone = false;

/** A frame counter climbs; nothing else in State climbs at this sort of rate. */
static bool PlausibleFrameRate(double rate) { return rate >= 5.0 && rate <= 1000.0; }

static void SearchFrameCounter() {
    if (g_fcDone || !g_state.base) return;
    size_t slots = g_state.window / 8;
    if (slots > FC_MAX_SLOTS) slots = FC_MAX_SLOTS;
    if (!slots || !Readable(g_state.base, slots * 8)) {
        g_fcDone = true;
        return;
    }
    const uint64_t* words = (const uint64_t*) g_state.base;
    DWORD now = GetTickCount();

    if (g_fcPhase == 0) {
        if (++g_fcRounds > FC_MAX_ROUNDS) {
            LogLine("no frame counter found in State; frame rate stays unavailable");
            g_fcDone = true;
            return;
        }
        for (size_t i = 0; i < slots; i++) g_fcSnapshot[i] = words[i];
        g_fcSlotCount = (int) slots;
        g_fcSnapshotTick = now;
        g_fcPhase = 1;
        return;
    }

    DWORD elapsed = now - g_fcSnapshotTick;
    if (elapsed < 500) return;

    if (g_fcPhase == 1) {
        g_fcCandidateCount = 0;
        for (int i = 0; i < g_fcSlotCount && g_fcCandidateCount < FC_MAX_CANDIDATES; i++) {
            uint64_t before = g_fcSnapshot[i], after = words[i];
            // Pointers and packed float pairs are huge; a counter is not.
            if (after <= before || after > ((uint64_t) 1 << 40)) continue;
            double rate = (double) (after - before) * 1000.0 / (double) elapsed;
            if (!PlausibleFrameRate(rate)) continue;
            g_fcCandidates[g_fcCandidateCount] = i;
            g_fcRates[g_fcCandidateCount] = rate;
            g_fcCandidateCount++;
        }
        for (int i = 0; i < g_fcSlotCount; i++) g_fcSnapshot[i] = words[i];
        g_fcSnapshotTick = now;
        g_fcPhase = g_fcCandidateCount ? 2 : 0;
        return;
    }

    // A candidate has to still be climbing, at about the rate it climbed at
    // before -- a value that merely happened to increase once does not qualify.
    for (int c = 0; c < g_fcCandidateCount; c++) {
        int slot = g_fcCandidates[c];
        uint64_t before = g_fcSnapshot[slot], after = words[slot];
        if (after <= before) continue;
        double rate = (double) (after - before) * 1000.0 / (double) elapsed;
        if (!PlausibleFrameRate(rate)) continue;
        if (rate > g_fcRates[c] * 3.0 || rate * 3.0 < g_fcRates[c]) continue;
        g_frameCount = (uint64_t*) (g_state.base + (size_t) slot * 8);
        g_lastFrames = 0;
        g_lastFrameTick = 0;
        LogLine("frame counter found at State+%d, climbing %.1f/s", slot * 8, rate);
        g_fcDone = true;
        return;
    }
    g_fcPhase = 0;
}

static const FieldDesc* FindField(const char* name) {
    for (size_t i = 0; i < kFieldCount; i++)
        if (_stricmp(kFields[i].name, name) == 0) return &kFields[i];
    return NULL;
}

/** Write one Config option, matching CustomOptional::operator=. */
static bool SetField(const char* name, const char* type, const char* value) {
    const FieldDesc* f = FindField(name);
    if (!f || !g_config) return false;
    unsigned char* at = (unsigned char*) g_config + f->offset;
    if (!Writable(at, 32)) return false;

    if (strcmp(type, "bool") == 0 && f->kind == OPTI_BOOL) {
        ((CustomOptional<bool>*) at)->assign(atoi(value) != 0);
    } else if (strcmp(type, "i32") == 0 && (f->kind == OPTI_I32 || f->kind == OPTI_U32)) {
        if (f->kind == OPTI_I32) ((CustomOptional<int32_t>*) at)->assign((int32_t) atoi(value));
        else ((CustomOptional<uint32_t>*) at)->assign((uint32_t) strtoul(value, NULL, 10));
    } else if (strcmp(type, "f32") == 0 && f->kind == OPTI_FLOAT) {
        ((CustomOptional<float>*) at)->assign((float) atof(value));
    } else if (strcmp(type, "str") == 0 && f->kind == OPTI_STR) {
        // v0.9.4 keeps the upscaler ids as strings rather than enums, so this
        // is the path the upscaler settings take.
        CustomOptional<msvc_string>* opt = (CustomOptional<msvc_string>*) at;
        size_t len = strlen(value);
        if (!Readable(&opt->base.value, sizeof(msvc_string))) return false;
        if (!opt->base.value.assign_in_place(value, len)) {
            snprintf(g_error, sizeof(g_error), "%s does not have room for \"%s\"", name, value);
            return false;
        }
        opt->base.engaged = true;
        opt->isVolatile = false;
    } else {
        return false;
    }
    LogLine("set %s (%s) = %s", name, type, value);
    return true;
}

/**
 * The second half of the overlay's upscaler switch: every entry in
 * State::changeBackend is set true, which is exactly what OptiScaler's own
 * MARK_ALL_BACKENDS_CHANGED macro does after writing State::newBackend.
 */
static int MarkBackendsChanged() {
    if (!g_backends.table || !Readable(g_backends.table, sizeof(ud_table))) return 0;
    msvc_vector_raw v = g_backends.table->m_values;
    backend_entry* entries = (backend_entry*) v.first;
    unsigned char* first = (unsigned char*) v.first;
    unsigned char* last = (unsigned char*) v.last;
    if (!first || last <= first) return 0;
    size_t count = (size_t) (last - first) / sizeof(backend_entry);
    if (count > 256) return 0;

    // Refuse to write unless every entry already holds a plausible bool; this
    // is the last guard against having latched onto the wrong container.
    if (!Readable(entries, count * sizeof(backend_entry))) return 0;
    for (size_t i = 0; i < count; i++) {
        if (entries[i].changed > 1) {
            snprintf(g_error, sizeof(g_error), "backend map entry %lu is not a bool (%u)",
                     (unsigned long) i, entries[i].changed);
            return 0;
        }
    }
    if (!Writable(entries, count * sizeof(backend_entry))) return 0;
    for (size_t i = 0; i < count; i++) entries[i].changed = 1;
    LogLine("marked %lu backend(s) as changed", (unsigned long) count);
    return (int) count;
}

/**
 * Switch the upscaler exactly the way the overlay does: write the backend id
 * into State::newBackend, then mark every live backend as changed. OptiScaler
 * picks it up on its next frame and rebuilds the feature.
 *
 * Config is deliberately not touched. OptiScaler writes the id it settled on
 * into Config::*Upscaler itself once the new feature has initialised, and
 * ChangeFeature treats an empty newBackend as "use Config", so writing Config
 * first is at best redundant. The host still records the choice in the ini, so
 * it survives to the next launch.
 */
static bool SwitchBackend(const char* code) {
    if (!IsBackendCode(code)) {
        snprintf(g_error, sizeof(g_error), "unknown backend id \"%s\"", code);
        return false;
    }
    if (!g_newBackend) {
        snprintf(g_error, sizeof(g_error), "newBackend not located; cannot switch upscaler");
        return false;
    }
    if (!Writable(g_newBackend, sizeof(msvc_string))) {
        snprintf(g_error, sizeof(g_error), "newBackend is not writable");
        return false;
    }
    if (!g_newBackend->assign_in_place(code, strlen(code))) {
        snprintf(g_error, sizeof(g_error), "no room to write backend id \"%s\"", code);
        return false;
    }
    int marked = MarkBackendsChanged();
    LogLine("newBackend = %s (%d backend(s) marked)", code, marked);
    if (marked == 0) {
        snprintf(g_error, sizeof(g_error),
                 "backend id set but no upscaler is live yet; it applies when one starts");
    }
    return true;
}

/**
 * Change the FFX frame generator, exactly as the overlay's "Change FG" button
 * does: the index into Config, then both State flags, in that order. Doing it
 * the other way round would let a frame land between the flags and the index
 * and rebuild the generator on the value that is already there.
 *
 * Unlike the upscaler switch, Config *is* the thing to write here --
 * FSRFG_Dx12::CreateContext reads Config::FfxFGIndex when it rebuilds, and the
 * flags are only what makes it rebuild.
 */
static bool SetFfxFgIndex(int index) {
    if (index < 0 || index >= FFX_FG_MAX) {
        snprintf(g_error, sizeof(g_error), "%d is not an FFX FG index", index);
        return false;
    }
    // OptiScaler clamps an out-of-range index to 0 rather than refusing it, so
    // an index this game does not have would silently select a different
    // generator from the one the user asked for. Refuse instead.
    if (g_ffxFgCount > 0 && index >= g_ffxFgCount) {
        snprintf(g_error, sizeof(g_error),
                 "this game reports %d FFX frame generator(s); %d is not one of them",
                 g_ffxFgCount, index);
        return false;
    }
    if (!g_fgFlags.fgChanged) {
        snprintf(g_error, sizeof(g_error),
                 "FGchanged/SCchanged not located; the FFX FG version cannot change now");
        return false;
    }
    if (!Writable(g_fgFlags.fgChanged, 2)) {
        snprintf(g_error, sizeof(g_error), "State's FG flags are not writable");
        return false;
    }

    char value[16];
    snprintf(value, sizeof(value), "%d", index);
    if (!SetField("FfxFGIndex", "i32", value)) {
        snprintf(g_error, sizeof(g_error), "could not write FfxFGIndex");
        return false;
    }
    *g_fgFlags.fgChanged = 1;
    *g_fgFlags.scChanged = 1;
    LogLine("FfxFGIndex = %d, FGchanged and SCchanged raised", index);
    return true;
}

/**
 * Change which FFX upscaler version runs -- the overlay's "FFX Upscaler" combo
 * and the "Change Upscaler" button beside it, which is
 *
 *     config->FfxUpscalerIndex = _ffxUpscalerIndex;
 *     state.newBackend = currentBackend;
 *     MARK_ALL_BACKENDS_CHANGED();
 *
 * The index is read when FSR31Feature_*::CreateContext builds its context, so
 * as with the FFX frame generator this is a Config write and what makes it take
 * effect now is forcing the feature to be rebuilt.
 *
 * Where the overlay names the current backend explicitly, this leaves
 * State::newBackend alone: FeatureProvider_*::ChangeFeature reads it as "use
 * whatever Config holds for this API" when it is empty, and OptiScaler clears
 * it itself once a rebuild has succeeded. That is the same rebuild by a route
 * that cannot pick the wrong graphics API -- and it composes with a real
 * upscaler switch in the same command, which writing over newBackend would
 * cancel.
 *
 * The mark is left to the caller so that a command doing both arrives as one
 * change rather than two: OptiScaler acts on the mark the next frame, and
 * marking before the index is written would rebuild on the old value.
 */
static bool SetFfxUpscalerIndex(int index) {
    if (index < 0 || index >= FFX_FG_MAX) {
        snprintf(g_error, sizeof(g_error), "%d is not an FFX upscaler index", index);
        return false;
    }
    // Out of range, OptiScaler resets the index to 0 and runs a version nobody
    // asked for. Refuse instead, exactly as the FFX FG index does.
    if (g_ffxUpscalerCount > 0 && index >= g_ffxUpscalerCount) {
        snprintf(g_error, sizeof(g_error),
                 "this game reports %d FFX upscaler version(s); %d is not one of them",
                 g_ffxUpscalerCount, index);
        return false;
    }
    if (!g_backends.table) {
        snprintf(g_error, sizeof(g_error),
                 "changeBackend not located; the FFX upscaler version cannot change now");
        return false;
    }

    char value[16];
    snprintf(value, sizeof(value), "%d", index);
    if (!SetField("FfxUpscalerIndex", "i32", value)) {
        snprintf(g_error, sizeof(g_error), "could not write FfxUpscalerIndex");
        return false;
    }
    LogLine("FfxUpscalerIndex = %d", index);
    return true;
}

// --------------------------------------------------------------- IPC files --

static char* ReadWholeFile(const wchar_t* path, DWORD* sizeOut) {
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    DWORD size = GetFileSize(h, NULL);
    if (size == INVALID_FILE_SIZE || size > 1 << 20) { CloseHandle(h); return NULL; }
    char* buf = (char*) HeapAlloc(GetProcessHeap(), 0, size + 1);
    DWORD got = 0;
    if (!buf || !ReadFile(h, buf, size, &got, NULL)) {
        if (buf) HeapFree(GetProcessHeap(), 0, buf);
        CloseHandle(h);
        return NULL;
    }
    buf[got] = 0;
    *sizeOut = got;
    CloseHandle(h);
    return buf;
}

/** Sample the frame counter, so the panel can show a frame rate. */
static void SampleFps() {
    if (g_frameCount && Readable(g_frameCount, sizeof(uint64_t))) {
        uint64_t frames = *g_frameCount;
        g_framesSeen = frames;
        DWORD now = GetTickCount();
        if (g_lastFrameTick && frames >= g_lastFrames) {
            DWORD elapsed = now - g_lastFrameTick;
            if (elapsed >= 500) {
                double rate = (double) (frames - g_lastFrames) * 1000.0 / (double) elapsed;
                // A counter this is not would produce nonsense; ignore it rather
                // than reporting a number the user would have to distrust.
                if (rate >= 0.0 && rate < 1000.0) g_fps = rate;
                g_lastFrames = frames;
                g_lastFrameTick = now;
            }
        } else {
            g_lastFrames = frames;
            g_lastFrameTick = now;
        }
    }
    // Still nothing moving where the declaration says it should be. Go and find
    // a counter that is; the search latches once it succeeds or gives up, so a
    // game that is genuinely paused does not restart it.
    if (g_fps <= 0.0) SearchFrameCounter();
}

/**
 * Fold this tick's frame intervals into the smoothed pair the status reports.
 *
 * Called on every pass of the worker loop rather than only when the status file
 * is written: each slot holds one frame's delta, so five readings a second and
 * a slow-moving average is the difference between a frame rate and a flicker.
 * Anything outside a plausible interval is dropped rather than averaged in --
 * OptiScaler leaves both at 0.0 until the first pair of frames, and a game that
 * has just resumed from a stall reports one enormous delta.
 */
// ---------------------------------------------- frame intervals, part two --
//
// FindFrameTimes knows where the two doubles are *declared*, at an offset the
// compiler works out from the mirror. That was not enough: on a real Deck both
// slots read as zero for a whole session while the frame counter eight bytes in
// front of the same table was perfectly correct, so the run of declarations
// between them contains a size this cannot see. Every type in that run is a
// standard one, which is exactly what makes the mistake invisible -- the
// arithmetic looks right and the readings simply never arrive.
//
// So the declared pair is a first guess, the way the frame counter's declared
// slot is, and when it never produces a reading the plugin goes looking for the
// pair instead. What it looks for is specific: two adjacent doubles, both
// inside the range a frame interval can occupy, both changing from one sample
// to the next, and at least one of them agreeing with the interval the frame
// counter implies. Read-only throughout, and two separate matches is a refusal
// rather than a coin toss.
//
// Which of the pair is which is deliberately not decided here. The host sorts
// them -- interpolation can only add frames, so the shorter interval is the
// presented one whichever slot it came out of -- so all this has to find is the
// pair.

#define FT_SCAN_FIRST 280   // past the last offset the version lists validate
#define FT_SCAN_LAST 704    // comfortably past where the pair is declared
#define FT_MAX_SLOTS ((FT_SCAN_LAST - FT_SCAN_FIRST) / 8)
#define FT_MAX_ROUNDS 12

static double g_ftSnapshot[FT_MAX_SLOTS];
static bool g_ftHaveSnapshot = false;
static int g_ftRounds = 0;
static bool g_ftDone = false;

static bool PlausibleInterval(double ms) { return ms > 0.05 && ms < 2000.0; }

/**
 * A double that is positively a frame interval: in range, remeasured since the
 * last sample, and agreeing with the interval the frame counter implies.
 *
 * Only one of the two has to pass this. The other is on the far side of the
 * generator and is free to differ from the counted rate -- and it can be
 * sitting at zero, because OptiScaler leaves a slot at 0.0 until the hook that
 * writes it has run, which for the frame-generation hook may be never.
 */
static bool FrameTimeAnchor(double now, double before, double expected) {
    if (!PlausibleInterval(now)) return false;
    // A frame interval is remeasured every frame. Anything that held still
    // across a whole tick is a constant that happens to sit in the range.
    if (now == before) return false;
    double ratio = now / expected;
    return ratio > 0.65 && ratio < 1.35;
}

static void SearchFrameTimes() {
    if (g_ftDone || !g_backends.table) return;
    // Without a frame rate there is nothing to recognise the pair by, and
    // matching only "two plausible doubles" would latch onto the first pair of
    // anything in the window.
    if (g_fps <= 0.0) return;
    if (++g_ftRounds > FT_MAX_ROUNDS) {
        LogLine("no frame-interval pair found in State; both rates stay unavailable");
        g_ftDone = true;
        return;
    }

    const unsigned char* base = (const unsigned char*) g_backends.table;
    if (!Readable(base + FT_SCAN_FIRST, FT_SCAN_LAST - FT_SCAN_FIRST + sizeof(double))) {
        g_ftDone = true;
        return;
    }

    double current[FT_MAX_SLOTS];
    for (int i = 0; i < FT_MAX_SLOTS; i++)
        memcpy(&current[i], base + FT_SCAN_FIRST + i * 8, sizeof(double));

    if (!g_ftHaveSnapshot) {
        memcpy(g_ftSnapshot, current, sizeof(current));
        g_ftHaveSnapshot = true;
        return;
    }

    const double expected = 1000.0 / g_fps;
    int anchor = -1;
    bool ambiguous = false;
    for (int i = 0; i < FT_MAX_SLOTS; i++) {
        if (!FrameTimeAnchor(current[i], g_ftSnapshot[i], expected)) continue;
        // The two are adjacent, and when nothing is being generated they hold
        // the same interval and both pass -- that is one pair, not two answers.
        if (anchor >= 0 && i > anchor + 1) { ambiguous = true; break; }
        if (anchor < 0) anchor = i;
    }

    memcpy(g_ftSnapshot, current, sizeof(current));

    if (ambiguous) {
        LogLine("more than one frame interval in State; refusing to guess");
        g_ftDone = true;
        return;
    }
    if (anchor < 0) return;

    // The anchor is one of the pair; the other is the neighbour. Prefer the one
    // below when it also looks like an interval, so a pair found by its second
    // member is still reported as a pair. When neither neighbour looks like
    // anything the anchor is still adopted -- one real interval reported is
    // worth more than none, and each value is range-checked again on the way
    // out, so an unrelated neighbour reports as no reading rather than as a
    // number.
    int start = anchor;
    if (anchor > 0 && PlausibleInterval(current[anchor - 1])) start = anchor - 1;
    if (start + 1 >= FT_MAX_SLOTS) start = FT_MAX_SLOTS - 2;

    size_t offset = (size_t) (FT_SCAN_FIRST + start * 8);
    g_frameTimes.rendered = (const double*) (base + offset);
    g_frameTimes.presented = (const double*) (base + offset + 8);
    LogLine("frame intervals found at +%zu (%.2f ms / %.2f ms), declared at +%zu",
            offset, current[start], current[start + 1],
            (size_t) offsetof(state_tail, lastFGFrameTime));
    g_ftDone = true;
}

static void SampleFrameTimes() {
    if (g_frameTimes.rendered && Readable(g_frameTimes.rendered, sizeof(double) * 2)) {
        const double samples[2] = { *g_frameTimes.rendered, *g_frameTimes.presented };
        double* averages[2] = { &g_renderedMs, &g_presentedMs };
        for (int i = 0; i < 2; i++) {
            double value = samples[i];
            if (!PlausibleInterval(value)) continue;
            *averages[i] = *averages[i] > 0.0
                ? *averages[i] + (value - *averages[i]) * 0.12
                : value;
        }
    }
    // Nothing has ever come out of the declared pair. Go and find one that is
    // actually being written; the search latches once it succeeds or gives up,
    // so this does not restart every tick for the rest of the session.
    if (g_renderedMs <= 0.0 && g_presentedMs <= 0.0) SearchFrameTimes();
}

/**
 * How many upscalers OptiScaler has registered, or -1 if that cannot be read.
 *
 * Zero is the interesting answer: the switch works by marking every entry of
 * State::changeBackend, so with no entries there is nothing to mark and the
 * upscaler cannot move yet however healthy everything else looks.
 */
static int BackendEntryCount() {
    if (!g_backends.table || !Readable(g_backends.table, sizeof(ud_table))) return -1;
    msvc_vector_raw v = g_backends.table->m_values;
    unsigned char* first = (unsigned char*) v.first;
    unsigned char* last = (unsigned char*) v.last;
    if (!first || last < first) return 0;
    size_t count = (size_t) (last - first) / sizeof(backend_entry);
    return count > 256 ? -1 : (int) count;
}

/** Read one bool option back out of Config, for reporting. */
static int ReadBoolField(const char* name) {
    const FieldDesc* f = FindField(name);
    if (!f || !g_config || f->kind != OPTI_BOOL) return -1;
    const CustomOptional<bool>* opt =
        (const CustomOptional<bool>*) ((unsigned char*) g_config + f->offset);
    if (!Readable(opt, sizeof(*opt))) return -1;
    return opt->value_or_default() ? 1 : 0;
}

/** Read one string option back out of Config, for reporting. */
static void ReadStringField(const char* name, char* out, size_t outLen) {
    out[0] = 0;
    const FieldDesc* f = FindField(name);
    if (!f || !g_config || f->kind != OPTI_STR) return;
    const CustomOptional<msvc_string>* opt =
        (const CustomOptional<msvc_string>*) ((unsigned char*) g_config + f->offset);
    if (!Readable(opt, sizeof(*opt))) return;
    const msvc_string* value = opt->base.engaged ? &opt->base.value : &opt->defaultValue;
    ReadStdString(value, out, outLen);
}

/** Read one integer option back out of Config, for reporting. */
static int ReadIntField(const char* name) {
    const FieldDesc* f = FindField(name);
    if (!f || !g_config || f->kind != OPTI_I32) return -1;
    const CustomOptional<int32_t>* opt =
        (const CustomOptional<int32_t>*) ((unsigned char*) g_config + f->offset);
    if (!Readable(opt, sizeof(*opt))) return -1;
    return opt->value_or_default();
}

/** One of the FFX version lists, joined for a single status line. */
static void FfxVersionList(const char names[FFX_FG_MAX][FFX_FG_NAME_MAX], int count,
                           char* out, size_t outLen) {
    out[0] = 0;
    size_t used = 0;
    for (int i = 0; i < count; i++) {
        int n = snprintf(out + used, outLen - used, "%s%s", used ? "|" : "", names[i]);
        if (n < 0 || (size_t) n >= outLen - used) { out[used] = 0; return; }
        used += (size_t) n;
    }
}

static void WriteStatus(const char* status) {
    SampleFps();
    SampleFrameTimes();

    char dx12[32] = "", dx11[32] = "", vk[32] = "", live[32] = "";
    ReadStringField("Dx12Upscaler", dx12, sizeof(dx12));
    ReadStringField("Dx11Upscaler", dx11, sizeof(dx11));
    ReadStringField("VulkanUpscaler", vk, sizeof(vk));
    if (g_newBackend && Readable(g_newBackend, sizeof(msvc_string)))
        ReadStdString(g_newBackend, live, sizeof(live));

    // Where the plugin decided its control files live. The host knows where it
    // *expects* them, so disagreement is the first thing worth seeing.
    char dir[MAX_PATH];
    NarrowCopy(dir, sizeof(dir), g_dir);

    char ffxFg[FFX_FG_MAX * FFX_FG_NAME_MAX];
    FfxVersionList(g_ffxFgNames, g_ffxFgCount, ffxFg, sizeof(ffxFg));
    char ffxUpscaler[FFX_FG_MAX * FFX_FG_NAME_MAX];
    FfxVersionList(g_ffxUpscalerNames, g_ffxUpscalerCount, ffxUpscaler, sizeof(ffxUpscaler));

    char body[4096];
    int n = snprintf(body, sizeof(body),
                     "schema 5\n"
                     "status %s\n"
                     "seq %ld\n"
                     "applied %d\n"
                     "config %p\n"
                     "state %p\n"
                     "backends %p\n"
                     "newbackend %p\n"
                     "framecount %p\n"
                     "backend_entries %d\n"
                     "frames %llu\n"
                     "dir %s\n"
                     "fps %.1f\n"
                     "fg_enabled %d\n"
                     "dx12_upscaler %s\n"
                     "dx11_upscaler %s\n"
                     "vulkan_upscaler %s\n"
                     "pending_backend %s\n"
                     "fgflags %p\n"
                     "fg_index %d\n"
                     "ffx_fg_versions %s\n"
                     "ffx_upscaler_index %d\n"
                     "ffx_upscaler_versions %s\n"
                     "rendered_ms %.3f\n"
                     "presented_ms %.3f\n"
                     "error %s\n",
                     status, g_seq, g_lastApplied, (void*) g_config, (void*) g_state.base,
                     (void*) g_backends.table, (void*) g_newBackend, (void*) g_frameCount,
                     BackendEntryCount(), (unsigned long long) g_framesSeen,
                     dir, g_fps, ReadBoolField("FGEnabled"), dx12, dx11, vk, live,
                     (void*) g_fgFlags.fgChanged, ReadIntField("FfxFGIndex"), ffxFg,
                     ReadIntField("FfxUpscalerIndex"), ffxUpscaler,
                     g_renderedMs, g_presentedMs, g_error);
    if (n < 0) return;
    HANDLE h = CreateFileW(g_statusPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    WriteFile(h, body, (DWORD) n, &written, NULL);
    CloseHandle(h);
}

/** Apply one command file. Returns the number of settings written. */
static int ApplyCommands(char* text) {
    int applied = 0;
    bool wantBackendChange = false;
    // Whatever went wrong last time is not evidence about this command, and a
    // stale line here reads as a live failure in the panel.
    g_error[0] = 0;
    char* cursor = text;
    while (*cursor) {
        char* line = cursor;
        while (*cursor && *cursor != '\n' && *cursor != '\r') cursor++;
        if (*cursor) *cursor++ = 0;
        while (*cursor == '\n' || *cursor == '\r') cursor++;
        while (*line == ' ' || *line == '\t') line++;
        if (!*line || *line == '#') continue;

        char verb[32] = "", a[64] = "", b[16] = "", c[128] = "";
        int parts = sscanf(line, "%31s %63s %15s %127s", verb, a, b, c);
        if (parts >= 2 && strcmp(verb, "seq") == 0) {
            g_seq = atol(a);
        } else if (parts >= 4 && strcmp(verb, "set") == 0) {
            if (SetField(a, b, c)) applied++;
            else LogLine("ignored unknown or mistyped field: %s", line);
        } else if (parts >= 2 && strcmp(verb, "backend") == 0) {
            if (SwitchBackend(a)) applied++;
        } else if (parts >= 2 && strcmp(verb, "fgindex") == 0) {
            if (SetFfxFgIndex(atoi(a))) applied++;
        } else if (parts >= 2 && strcmp(verb, "ffxupscaler") == 0) {
            // The rebuild it needs is deferred to the end of the command, so a
            // "backend" line in the same one supplies it instead of racing it.
            if (SetFfxUpscalerIndex(atoi(a))) { applied++; wantBackendChange = true; }
        } else if (strcmp(verb, "apply-backend") == 0) {
            wantBackendChange = true;
        }
    }
    if (wantBackendChange) {
        int marked = MarkBackendsChanged();
        if (marked) applied++;
    }
    return applied;
}

// ------------------------------------------------------------------ worker --

/**
 * One attempt at locating changeBackend, newBackend and the frame counter.
 *
 * All three come from the same scan, because all three are positions relative
 * to the one object that has to be identified. Either they are all set or none
 * of them are, which is what keeps "found the map but not the string" -- the
 * state the previous version got permanently stuck in -- from existing at all.
 */
static bool DiscoverBackendMap() {
    BackendMap found = { NULL, NULL };
    ScopedScanCache cache;
    if (!FindChangeBackend(&g_state, &found)) return false;
    g_backends = found;
    g_newBackend = found.newBackend;
    g_frameCount = FindFrameCount(&g_backends);
    FindFrameTimes(&g_backends, &g_frameTimes);
    return true;
}

/** Copy one of the FFX version lists out of State, once it exists. */
static bool AdoptFfxVersions(size_t namesOffset, size_t idsOffset, const char* what,
                             char into[FFX_FG_MAX][FFX_FG_NAME_MAX], int* countInto) {
    char names[FFX_FG_MAX][FFX_FG_NAME_MAX];
    int count = 0;
    if (!ReadFfxVersions(&g_backends, namesOffset, idsOffset, names, &count)) return false;
    for (int i = 0; i < count; i++) {
        memcpy(into[i], names[i], FFX_FG_NAME_MAX);
        LogLine("FFX %s version %d: %s", what, i, into[i]);
    }
    *countInto = count;
    return true;
}

/**
 * The rest of what State has to offer, all of which depends on the map above.
 *
 * Kept apart from DiscoverBackendMap because none of it is required for the
 * upscaler switch, and because both version lists are genuinely not there until
 * the game has asked the FFX SDK what it can do -- so this is retried, and a
 * failure here never costs anything that already works.
 */
static void DiscoverStateExtras() {
    if (!g_state.base || !g_backends.table) return;
    if (!g_fgFlags.fgChanged) FindFgFlags(&g_state, &g_backends, &g_fgFlags);
    if (g_ffxFgCount == 0)
        AdoptFfxVersions(offsetof(state_tail, ffxFGVersionNames),
                         offsetof(state_tail, ffxFGVersionIds), "FG",
                         g_ffxFgNames, &g_ffxFgCount);
    if (g_ffxUpscalerCount == 0)
        AdoptFfxVersions(offsetof(state_tail, ffxUpscalerVersionNames),
                         offsetof(state_tail, ffxUpscalerVersionIds), "upscaler",
                         g_ffxUpscalerNames, &g_ffxUpscalerCount);
}

/** Poll ticks between status rewrites; the loop sleeps 200ms per tick. */
#define HEARTBEAT_TICKS 15  /* ~3s */

static DWORD WINAPI Worker(LPVOID) {
    DeleteFileW(g_logPath);
    char dir[MAX_PATH];
    NarrowCopy(dir, sizeof(dir), g_dir);
    LogLine("decky_optiscaler_live: loaded, %lu config fields known",
            (unsigned long) kFieldCount);
    LogLine("control files in: %s", dir);
    // Say we exist before doing anything slow, so "did OptiScaler load it at
    // all?" is answerable without waiting for discovery to finish or fail.
    WriteStatus("loaded");
    // Let OptiScaler finish its own startup, and let the loader lock go, before
    // walking module memory.
    Sleep(3000);

    HMODULE opti = FindOptiScalerModule();
    if (!opti) {
        snprintf(g_error, sizeof(g_error), "OptiScaler module not found in this process");
        LogLine("%s", g_error);
        WriteStatus("failed");
        return 0;
    }

    wchar_t dllPath[MAX_PATH];
    GetModuleFileNameW(opti, dllPath, MAX_PATH);
    LogLine("OptiScaler module at %p", (void*) opti);

    char exePath[MAX_PATH];
    GetModuleFileNameA(NULL, exePath, MAX_PATH);
    const char* exeName = strrchr(exePath, '\\');
    exeName = exeName ? exeName + 1 : exePath;
    LogLine("game executable: %s", exeName);

    // Discovery can legitimately need a few seconds: State's game strings are
    // filled in during OptiScaler's init and the feature map only exists once
    // the game has created an upscaler.
    for (int attempt = 0; attempt < 60; attempt++) {
        if (!g_config) g_config = FindConfig(opti);
        if (!g_state.base) FindState(opti, exeName, &g_state);
        if (g_state.base && !g_backends.table) DiscoverBackendMap();
        DiscoverStateExtras();
        if (g_config && g_state.base && g_backends.table) break;
        WriteStatus("searching");
        Sleep(1000);
    }

    if (!g_config) {
        snprintf(g_error, sizeof(g_error), "could not locate OptiScaler's config object");
        LogLine("%s", g_error);
        WriteStatus("failed");
        return 0;
    }
    LogLine("config at %p, state at %p, backend map at %p", (void*) g_config, (void*) g_state.base,
            (void*) g_backends.table);
    if (!g_backends.table)
        LogLine("changeBackend not located yet; still looking");

    WriteStatus("ready");

    FILETIME lastWrite = { 0, 0 };
    int rediscover = 0;
    int rediscoverFg = 0;
    int heartbeat = 0;
    for (;;) {
        // The host decides whether the game is still there by how fresh this
        // file is, so it has to be rewritten even when nothing is happening --
        // otherwise a session with no setting changes reads as "not connected"
        // a minute and a half in, which is exactly what it used to do.
        if (++heartbeat >= HEARTBEAT_TICKS) {
            heartbeat = 0;
            WriteStatus(g_config ? "ready" : "searching");
        }

        // State is a static, so once the map is located it stays located --
        // but a game that has not upscaled yet may not have written to it, and
        // OptiScaler's own init can still be filling State's strings in when
        // the first scan runs. Keep looking until it is found rather than
        // giving up on upscaler switching for the whole session.
        if (!g_backends.table && ++rediscover >= 25) {  // every ~5s
            rediscover = 0;
            if (!g_state.base) FindState(opti, exeName, &g_state);
            if (g_state.base && DiscoverBackendMap()) WriteStatus("ready");
        }

        // The FFX version lists appear only once the game has queried the SDK,
        // and the flags need the map, so keep asking as long as any of them is
        // missing. All are cheap the moment they are found.
        if ((!g_fgFlags.fgChanged || g_ffxFgCount == 0 || g_ffxUpscalerCount == 0)
            && ++rediscoverFg >= 25) {
            rediscoverFg = 0;
            DiscoverStateExtras();
        }

        // Each of these two slots holds one frame's interval, so they are read
        // at the loop's own rate and smoothed, not sampled once every heartbeat.
        SampleFrameTimes();

        WIN32_FILE_ATTRIBUTE_DATA info;
        if (GetFileAttributesExW(g_cmdPath, GetFileExInfoStandard, &info)) {
            if (CompareFileTime(&info.ftLastWriteTime, &lastWrite) != 0) {
                lastWrite = info.ftLastWriteTime;
                DWORD size = 0;
                char* text = ReadWholeFile(g_cmdPath, &size);
                if (text) {
                    g_lastApplied = ApplyCommands(text);
                    HeapFree(GetProcessHeap(), 0, text);
                    WriteStatus("ready");
                }
            }
        }
        Sleep(200);
    }
}

// ------------------------------------------------------------------ exports --

/** dst = dir + "\\" + leaf, truncating rather than overflowing. */
static void JoinPath(wchar_t* dst, const wchar_t* dir, const wchar_t* leaf) {
    size_t i = 0;
    while (dir[i] && i < MAX_PATH - 2) { dst[i] = dir[i]; i++; }
    if (i && dst[i - 1] != L'\\' && i < MAX_PATH - 2) dst[i++] = L'\\';
    size_t j = 0;
    while (leaf[j] && i < MAX_PATH - 1) dst[i++] = leaf[j++];
    dst[i] = 0;
}

static void SetUpPaths(HMODULE self) {
    wchar_t path[MAX_PATH];
    path[0] = 0;
    GetModuleFileNameW(self, path, MAX_PATH);
    wchar_t* slash = wcsrchr(path, L'\\');
    if (slash) *slash = 0;
    // The .asi lives in <optiscaler dir>\plugins, so the control files go one
    // level up, next to OptiScaler.ini where the plugin already writes.
    wchar_t* up = wcsrchr(path, L'\\');
    if (up && _wcsicmp(up + 1, L"plugins") == 0) *up = 0;
    wcsncpy(g_dir, path, MAX_PATH - 1);
    g_dir[MAX_PATH - 1] = 0;

    // Built by hand rather than with swprintf. Under mingw's C99-conformant
    // wide printf, "%s" in a *wide* format string consumes a char*, not a
    // wchar_t*: the first byte of a UTF-16 path is a letter followed by a NUL,
    // so every one of these paths silently collapsed to a one-character
    // relative name and the plugin wrote its status file into the game's
    // working directory, where nothing was looking for it. Concatenation has
    // no such ambiguity.
    JoinPath(g_logPath, g_dir, L"decky_optiscaler_live.log");
    JoinPath(g_cmdPath, g_dir, L"decky_optiscaler_live.cmd");
    JoinPath(g_statusPath, g_dir, L"decky_optiscaler_live.status");
}

static LONG g_started = 0;

static void StartWorkerOnce(void) {
    if (InterlockedCompareExchange(&g_started, 1, 0) != 0) return;
    HANDLE thread = CreateThread(NULL, 0, Worker, NULL, 0, NULL);
    if (thread) CloseHandle(thread);
}

// OptiScaler calls this after LoadLibrary; it is optional for us, since the
// worker is already on its way, but its presence is how OptiScaler logs the
// plugin as initialised.
extern "C" __declspec(dllexport) void InitializeASI(void) { StartWorkerOnce(); }

BOOL WINAPI DllMain(HINSTANCE self, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(self);
        // Path setup is pure string work -- safe under the loader lock, unlike
        // the file I/O and module scanning, which all happen on the worker.
        SetUpPaths(self);
        StartWorkerOnce();
    }
    return TRUE;
}
