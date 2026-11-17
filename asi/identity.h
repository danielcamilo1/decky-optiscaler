// Checked memory and pinned-core identity helpers. No memory scanning.
static size_t WStrLen(const wchar_t* value) {
    size_t n = 0;
    while (value && value[n]) ++n;
    return n;
}

static void CopyBytes(void* destination, const void* source, size_t count) {
    BYTE* dst = static_cast<BYTE*>(destination);
    const BYTE* src = static_cast<const BYTE*>(source);
    for (size_t i = 0; i < count; ++i) dst[i] = src[i];
}

static bool BytesEqual(const void* left, const void* right, size_t count) {
    const BYTE* a = static_cast<const BYTE*>(left);
    const BYTE* b = static_cast<const BYTE*>(right);
    for (size_t i = 0; i < count; ++i)
        if (a[i] != b[i]) return false;
    return true;
}

static bool WStringEqualNoCase(const wchar_t* left, const wchar_t* right) {
    size_t i = 0;
    while (left[i] && right[i]) {
        wchar_t a = left[i], b = right[i];
        if (a >= L'A' && a <= L'Z') a = static_cast<wchar_t>(a + (L'a' - L'A'));
        if (b >= L'A' && b <= L'Z') b = static_cast<wchar_t>(b + (L'a' - L'A'));
        if (a != b) return false;
        ++i;
    }
    return left[i] == right[i];
}

static bool IsReadableProtection(DWORD protection) {
    switch (protection & 0xffu) {
    case PAGE_READONLY:
    case PAGE_READWRITE:
    case PAGE_WRITECOPY:
    case PAGE_EXECUTE_READ:
    case PAGE_EXECUTE_READWRITE:
    case PAGE_EXECUTE_WRITECOPY:
        return true;
    default:
        return false;
    }
}

static bool IsWritableProtection(DWORD protection) {
    switch (protection & 0xffu) {
    case PAGE_READWRITE:
    case PAGE_WRITECOPY:
    case PAGE_EXECUTE_READWRITE:
    case PAGE_EXECUTE_WRITECOPY:
        return true;
    default:
        return false;
    }
}

static bool CheckMemory(const void* address, size_t length, bool write) {
    if (!address || !length) return false;
    uintptr_t current = reinterpret_cast<uintptr_t>(address);
    if (current > UINTPTR_MAX - length) return false;
    uintptr_t end = current + length;
    while (current < end) {
        MEMORY_BASIC_INFORMATION info;
        SIZE_T queried = VirtualQuery(reinterpret_cast<const void*>(current), &info, sizeof(info));
        if (queried != sizeof(info) || info.State != MEM_COMMIT || (info.Protect & PAGE_GUARD))
            return false;
        uintptr_t regionStart = reinterpret_cast<uintptr_t>(info.BaseAddress);
        if (regionStart > UINTPTR_MAX - info.RegionSize) return false;
        uintptr_t regionEnd = regionStart + info.RegionSize;
        if (current < regionStart || current >= regionEnd) return false;
        if (write ? !IsWritableProtection(info.Protect) : !IsReadableProtection(info.Protect))
            return false;
        uintptr_t next = regionEnd < end ? regionEnd : end;
        if (next <= current) return false;
        current = next;
    }
    return true;
}

static bool ReadBytes(const void* source, void* destination, size_t length) {
    if (!destination || !CheckMemory(source, length, false)) return false;
    SIZE_T read = 0;
    if (!ReadProcessMemory(GetCurrentProcess(), source, destination, length, &read)) return false;
    return read == length;
}

static bool RvaFits(DWORD rva, size_t length, DWORD imageSize) {
    if (!length || rva >= imageSize) return false;
    return length <= static_cast<size_t>(imageSize - rva);
}

static bool ReadRva(const BYTE* base, DWORD imageSize, DWORD rva, void* destination, size_t length) {
    if (!base || !RvaFits(rva, length, imageSize)) return false;
    uintptr_t address = reinterpret_cast<uintptr_t>(base);
    if (address > UINTPTR_MAX - rva) return false;
    return ReadBytes(reinterpret_cast<const void*>(address + rva), destination, length);
}

static bool IsDataRva(DWORD rva, size_t length) {
    if (!length || length > UINT32_MAX ||
        rva > UINT32_MAX - static_cast<DWORD>(length)) return false;
    DWORD end = rva + static_cast<DWORD>(length);
    for (size_t i = 0; i < g_dataSectionCount; ++i) {
        DWORD sectionEnd = g_dataSections[i].start + g_dataSections[i].size;
        if (rva >= g_dataSections[i].start && end <= sectionEnd) return true;
    }
    return false;
}

static bool ReadDataRva(DWORD rva, void* destination, size_t length) {
    if (!g_coreBase || !IsDataRva(rva, length)) return false;
    return ReadRva(g_coreBase, g_coreImageSize, rva, destination, length);
}

struct ParsedImage {
    IMAGE_NT_HEADERS64 nt;
    SectionRange dataSections[kMaxSections];
    size_t dataSectionCount;
};

static bool ValidateLoadedImage(const BYTE* base, DWORD mappedImageSize, ParsedImage* parsed) {
    if (!base || !parsed || mappedImageSize != kExpectedSizeOfImage) return false;
    IMAGE_DOS_HEADER dos;
    if (!ReadBytes(base, &dos, sizeof(dos)) || dos.e_magic != IMAGE_DOS_SIGNATURE) return false;
    if (dos.e_lfanew < static_cast<LONG>(sizeof(IMAGE_DOS_HEADER)) ||
        static_cast<DWORD>(dos.e_lfanew) > mappedImageSize - sizeof(IMAGE_NT_HEADERS64)) return false;

    uintptr_t baseAddress = reinterpret_cast<uintptr_t>(base);
    if (baseAddress > UINTPTR_MAX - static_cast<DWORD>(dos.e_lfanew)) return false;
    uintptr_t ntAddress = baseAddress + static_cast<DWORD>(dos.e_lfanew);
    if (!ReadBytes(reinterpret_cast<const void*>(ntAddress), &parsed->nt, sizeof(parsed->nt))) return false;
    const IMAGE_NT_HEADERS64* nt = &parsed->nt;
    if (nt->Signature != IMAGE_NT_SIGNATURE ||
        nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
        nt->FileHeader.TimeDateStamp != kExpectedTimestamp ||
        nt->FileHeader.SizeOfOptionalHeader != sizeof(IMAGE_OPTIONAL_HEADER64) ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
        nt->OptionalHeader.SizeOfImage != kExpectedSizeOfImage ||
        nt->OptionalHeader.SizeOfHeaders > mappedImageSize ||
        nt->OptionalHeader.NumberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_DEBUG ||
        nt->FileHeader.NumberOfSections == 0 ||
        nt->FileHeader.NumberOfSections > 96) return false;

    size_t sectionHeaderOffset = static_cast<size_t>(dos.e_lfanew) + sizeof(DWORD) +
        sizeof(IMAGE_FILE_HEADER) + nt->FileHeader.SizeOfOptionalHeader;
    size_t sectionHeadersSize = static_cast<size_t>(nt->FileHeader.NumberOfSections) *
        sizeof(IMAGE_SECTION_HEADER);
    if (!RvaFits(static_cast<DWORD>(sectionHeaderOffset), sectionHeadersSize, mappedImageSize))
        return false;
    parsed->dataSectionCount = 0;
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; ++i) {
        IMAGE_SECTION_HEADER section;
        DWORD sectionRva = static_cast<DWORD>(sectionHeaderOffset +
            static_cast<size_t>(i) * sizeof(IMAGE_SECTION_HEADER));
        if (!ReadRva(base, mappedImageSize, sectionRva, &section, sizeof(section))) return false;
        if (!(section.Characteristics & IMAGE_SCN_MEM_READ) ||
            !(section.Characteristics & IMAGE_SCN_MEM_WRITE) ||
            (section.Characteristics & IMAGE_SCN_MEM_EXECUTE)) continue;
        DWORD regionSize = section.Misc.VirtualSize ? section.Misc.VirtualSize : section.SizeOfRawData;
        if (!regionSize || !RvaFits(section.VirtualAddress, regionSize, mappedImageSize)) return false;
        if (parsed->dataSectionCount < kMaxSections) {
            SectionRange& range = parsed->dataSections[parsed->dataSectionCount++];
            range.start = section.VirtualAddress;
            range.size = regionSize;
        }
    }
    if (!parsed->dataSectionCount) return false;

    IMAGE_DATA_DIRECTORY debugDirectory =
        nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DEBUG];
    if (!debugDirectory.VirtualAddress || debugDirectory.Size < sizeof(IMAGE_DEBUG_DIRECTORY) ||
        debugDirectory.Size > 4096 ||
        debugDirectory.Size % sizeof(IMAGE_DEBUG_DIRECTORY) != 0 ||
        !RvaFits(debugDirectory.VirtualAddress, debugDirectory.Size, mappedImageSize)) return false;

    bool matched = false;
    size_t count = debugDirectory.Size / sizeof(IMAGE_DEBUG_DIRECTORY);
    for (size_t i = 0; i < count; ++i) {
        IMAGE_DEBUG_DIRECTORY entry;
        DWORD entryRva = debugDirectory.VirtualAddress +
            static_cast<DWORD>(i * sizeof(IMAGE_DEBUG_DIRECTORY));
        if (!ReadRva(base, mappedImageSize, entryRva, &entry, sizeof(entry))) return false;
        if (entry.Type != IMAGE_DEBUG_TYPE_CODEVIEW || entry.SizeOfData < 24 ||
            !RvaFits(entry.AddressOfRawData, 24, mappedImageSize)) continue;
        BYTE codeView[24];
        if (!ReadRva(base, mappedImageSize, entry.AddressOfRawData, codeView, sizeof(codeView)))
            return false;
        DWORD signature;
        DWORD age;
        CopyBytes(&signature, codeView, sizeof(signature));
        CopyBytes(&age, codeView + 20, sizeof(age));
        if (signature == 0x53445352u && age == kExpectedPdbAge &&
            BytesEqual(codeView + 4, kExpectedPdbGuid, sizeof(kExpectedPdbGuid))) {
            matched = true;
            break;
        }
    }
    if (!matched) return false;

    // The fixed addresses must fit in readable/writable non-executable PE data
    // ranges. Their bytes are not read until the caller also checks the
    // on-disk DLL SHA-256.
    bool configRange = false, stateRange = false;
    for (size_t i = 0; i < parsed->dataSectionCount; ++i) {
        DWORD end = parsed->dataSections[i].start + parsed->dataSections[i].size;
        if (kConfigPointerRva >= parsed->dataSections[i].start &&
            kConfigPointerRva + sizeof(uintptr_t) <= end) configRange = true;
        if (kStateRva >= parsed->dataSections[i].start &&
            kStateRva + sizes_state <= end) stateRange = true;
    }
    return configRange && stateRange;
}

static uint32_t RotateRight(uint32_t value, unsigned amount) {
    return (value >> amount) | (value << (32 - amount));
}

static void Sha256Transform(Sha256* context, const BYTE* block) {
    static const uint32_t constants[64] = {
        0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
        0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
        0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
        0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
        0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
        0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
        0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
        0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
    };
    uint32_t words[64];
    for (unsigned i = 0; i < 16; ++i) {
        words[i] = (static_cast<uint32_t>(block[i * 4]) << 24) |
            (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
            (static_cast<uint32_t>(block[i * 4 + 2]) << 8) |
            static_cast<uint32_t>(block[i * 4 + 3]);
    }
    for (unsigned i = 16; i < 64; ++i) {
        uint32_t s0 = RotateRight(words[i - 15], 7) ^ RotateRight(words[i - 15], 18) ^
            (words[i - 15] >> 3);
        uint32_t s1 = RotateRight(words[i - 2], 17) ^ RotateRight(words[i - 2], 19) ^
            (words[i - 2] >> 10);
        words[i] = words[i - 16] + s0 + words[i - 7] + s1;
    }
    uint32_t a = context->state[0], b = context->state[1], c = context->state[2];
    uint32_t d = context->state[3], e = context->state[4], f = context->state[5];
    uint32_t g = context->state[6], h = context->state[7];
    for (unsigned i = 0; i < 64; ++i) {
        uint32_t s1 = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
        uint32_t choice = (e & f) ^ (~e & g);
        uint32_t temp1 = h + s1 + choice + constants[i] + words[i];
        uint32_t s0 = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
        uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        uint32_t temp2 = s0 + majority;
        h = g; g = f; f = e; e = d + temp1;
        d = c; c = b; b = a; a = temp1 + temp2;
    }
    context->state[0] += a; context->state[1] += b; context->state[2] += c;
    context->state[3] += d; context->state[4] += e; context->state[5] += f;
    context->state[6] += g; context->state[7] += h;
}

static void Sha256Init(Sha256* context) {
    static const uint32_t initial[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
    };
    CopyBytes(context->state, initial, sizeof(initial));
    context->bitCount = 0;
    context->used = 0;
}

static void Sha256Update(Sha256* context, const BYTE* data, size_t length) {
    context->bitCount += static_cast<uint64_t>(length) * 8u;
    while (length) {
        size_t take = sizeof(context->block) - context->used;
        if (take > length) take = length;
        CopyBytes(context->block + context->used, data, take);
        context->used += take;
        data += take;
        length -= take;
        if (context->used == sizeof(context->block)) {
            Sha256Transform(context, context->block);
            context->used = 0;
        }
    }
}

static void Sha256Final(Sha256* context, BYTE digest[32]) {
    uint64_t bits = context->bitCount;
    context->block[context->used++] = 0x80;
    if (context->used > 56) {
        while (context->used < 64) context->block[context->used++] = 0;
        Sha256Transform(context, context->block);
        context->used = 0;
    }
    while (context->used < 56) context->block[context->used++] = 0;
    for (unsigned i = 0; i < 8; ++i)
        context->block[63 - i] = static_cast<BYTE>(bits >> (i * 8));
    Sha256Transform(context, context->block);
    context->used = 0;
    for (unsigned i = 0; i < 8; ++i) {
        digest[i * 4] = static_cast<BYTE>(context->state[i] >> 24);
        digest[i * 4 + 1] = static_cast<BYTE>(context->state[i] >> 16);
        digest[i * 4 + 2] = static_cast<BYTE>(context->state[i] >> 8);
        digest[i * 4 + 3] = static_cast<BYTE>(context->state[i]);
    }
}

static bool HashFileSha256(const wchar_t* path, BYTE digest[32]) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE |
        FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (file == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER fileSize;
    if (!GetFileSizeEx(file, &fileSize) || fileSize.QuadPart <= 0 ||
        fileSize.QuadPart > 128ll * 1024ll * 1024ll) {
        CloseHandle(file);
        return false;
    }
    Sha256 context;
    Sha256Init(&context);
    BYTE buffer[8192];
    uint64_t totalRead = 0;
    bool ok = true;
    for (;;) {
        DWORD read = 0;
        if (!ReadFile(file, buffer, sizeof(buffer), &read, NULL)) { ok = false; break; }
        if (!read) break;
        totalRead += read;
        Sha256Update(&context, buffer, read);
    }
    LARGE_INTEGER afterSize;
    if (!GetFileSizeEx(file, &afterSize) || afterSize.QuadPart != fileSize.QuadPart ||
        totalRead != static_cast<uint64_t>(fileSize.QuadPart)) ok = false;
    CloseHandle(file);
    if (!ok) return false;
    Sha256Final(&context, digest);
    return true;
}

static bool HashMatchesPinnedCore(const wchar_t* path) {
    BYTE expected[32];
    auto nibble=[](char c)->BYTE{return c>='0'&&c<='9'?(BYTE)(c-'0'):(BYTE)(c-'a'+10);};
    for(size_t i=0;i<32;++i)expected[i]=(BYTE)((nibble(core_sha256[i*2])<<4)|nibble(core_sha256[i*2+1]));
    BYTE digest[32];
    return HashFileSha256(path, digest) && BytesEqual(digest, expected, sizeof(expected));
}


// The synchronous LoadAsiPlugins callback validates the mapped PE/PDB profile
// before it can install RenderMenu. The complete file hash is intentionally a
// worker task; until it passes, RenderMenuHook only calls the original.
static bool ValidateCoreImage(HMODULE module) {
    MODULEINFO info;
    if (!GetModuleInformation(GetCurrentProcess(), module, &info, sizeof(info)) ||
        !info.lpBaseOfDll || info.SizeOfImage != kExpectedSizeOfImage) return false;
    ParsedImage parsed;
    if (!ValidateLoadedImage(static_cast<const BYTE*>(info.lpBaseOfDll), info.SizeOfImage, &parsed))
        return false;
    uintptr_t configSlot = 0;
    uint64_t frameCount = 0;
    // PE headers, CodeView GUID+age and mapped data ranges are pinned before
    // the first read from a fixed PDB-backed RVA.
    if (!ReadRva(static_cast<const BYTE*>(info.lpBaseOfDll), info.SizeOfImage,
                 kConfigPointerRva, &configSlot, sizeof(configSlot)) ||
        !ReadRva(static_cast<const BYTE*>(info.lpBaseOfDll), info.SizeOfImage,
                 kStateRva + kFrameCountOffset, &frameCount, sizeof(frameCount))) return false;
    g_core = module;
    g_coreBase = static_cast<BYTE*>(info.lpBaseOfDll);
    g_coreImageSize = info.SizeOfImage;
    g_dataSectionCount = parsed.dataSectionCount;
    for (size_t i = 0; i < parsed.dataSectionCount; ++i)
        g_dataSections[i] = parsed.dataSections[i];
    g_coreValid = true;
    return true;
}

static bool ReadConfigPointer(uintptr_t* result) {
    if (!result) return false;
    uintptr_t config = 0;
    if (!ReadDataRva(kConfigPointerRva, &config, sizeof(config))) return false;
    *result = config;
    return true;
}

static bool ConfigPointerMatches(uintptr_t expected) {
    uintptr_t current = 0;
    return expected && ReadConfigPointer(&current) && current == expected;
}

static bool ConfigReadAt(uintptr_t config, size_t offset, void* destination, size_t length) {
    if (!destination || !config || offset > sizeof(Config) || length > sizeof(Config) - offset ||
        !ConfigPointerMatches(config)) return false;
    if (config > UINTPTR_MAX - sizeof(Config) ||
        !CheckMemory(reinterpret_cast<const void*>(config), sizeof(Config), false)) return false;
    if (config > UINTPTR_MAX - offset) return false;
    if (!ReadBytes(reinterpret_cast<const void*>(config + offset), destination, length)) return false;
    return ConfigPointerMatches(config);
}

static bool ReadWStringAt(uintptr_t config, size_t offset, wchar_t* output, size_t outputCapacity) {
    msvc_wstring value;
    if (!ConfigReadAt(config, offset, &value, sizeof(value)) ||
        value.size > 0x8000 || value.capacity < value.size || value.size + 1 > outputCapacity ||
        !ConfigPointerMatches(config)) return false;
    const wchar16* remote = value.capacity <= 7 ? value.bx.buf : value.bx.ptr;
    if (!remote || value.size > (SIZE_MAX / sizeof(wchar16)) - 1) return false;
    size_t bytes = (value.size + 1) * sizeof(wchar16);
    wchar16 temporary[512];
    if (value.size + 1 > sizeof(temporary) / sizeof(temporary[0]) ||
        !ReadBytes(remote, temporary, bytes) || !ConfigPointerMatches(config)) return false;
    if (temporary[value.size] != 0) return false;
    for (size_t i = 0; i < value.size; ++i) {
        if (!temporary[i]) return false;
        output[i] = static_cast<wchar_t>(temporary[i]);
    }
    output[value.size] = 0;
    return true;
}

static bool WideEndsWithNoCase(const wchar_t* value, const wchar_t* suffix) {
    size_t valueLength = WStrLen(value), suffixLength = WStrLen(suffix);
    if (valueLength < suffixLength) return false;
    return WStringEqualNoCase(value + valueLength - suffixLength, suffix);
}

static bool IsAbsoluteWindowsPath(const wchar_t* value) {
    if (!value || !value[0] || !value[1]) return false;
    if (value[0] == L'\\' && value[1] == L'\\') return true;
    if (((value[0] >= L'A' && value[0] <= L'Z') ||
         (value[0] >= L'a' && value[0] <= L'z')) && value[1] == L':' &&
        (value[2] == L'\\' || value[2] == L'/')) return true;
    return false;
}

static bool ReadDefaultValue(uintptr_t config, size_t fieldOffset, size_t defaultOffset,
                             void* value, size_t valueSize) {
    if (fieldOffset > sizeof(Config) || defaultOffset > sizeof(Config) - fieldOffset ||
        valueSize > sizeof(Config) - fieldOffset - defaultOffset) return false;
    return ConfigReadAt(config, fieldOffset + defaultOffset, value, valueSize);
}

static bool ValidateConfigAt(uintptr_t config) {
    if (config < 0x10000u || config > 0x00007fffffffffffull ||
        (config & 0xfu) || !ConfigPointerMatches(config) ||
        config > UINTPTR_MAX - sizeof(Config) ||
        !CheckMemory(reinterpret_cast<const void*>(config), sizeof(Config), false)) return false;
    wchar_t filename[512], absolutePath[512];
    if (!ReadWStringAt(config, offsetof(Config, fileName), filename, 512) ||
        !WStringEqualNoCase(filename, L"OptiScaler.ini")) return false;
    if (!ReadWStringAt(config, offsetof(Config, absoluteFileName), absolutePath, 512) ||
        !IsAbsoluteWindowsPath(absolutePath) ||
        !WideEndsWithNoCase(absolutePath, L"\\OptiScaler.ini")) return false;
    int32_t shortcut = 0, fpsShortcut = 0, fgShortcut = 0;
    float fontSize = 0.0f, sharpness = 0.0f, reactiveBias = 0.0f;
    if (!ReadDefaultValue(config, offsetof(Config, ShortcutKey),
                          offsetof(CustomOptional<int32_t>, defaultValue), &shortcut, sizeof(shortcut)) ||
        !ReadDefaultValue(config, offsetof(Config, FpsShortcutKey),
                          offsetof(CustomOptional<int32_t>, defaultValue), &fpsShortcut, sizeof(fpsShortcut)) ||
        !ReadDefaultValue(config, offsetof(Config, FGShortcutKey),
                          offsetof(CustomOptional<int32_t>, defaultValue), &fgShortcut, sizeof(fgShortcut)) ||
        !ReadDefaultValue(config, offsetof(Config, FontSize),
                          offsetof(CustomOptional<float>, defaultValue), &fontSize, sizeof(fontSize)) ||
        !ReadDefaultValue(config, offsetof(Config, Sharpness),
                          offsetof(CustomOptional<float>, defaultValue), &sharpness, sizeof(sharpness)) ||
        !ReadDefaultValue(config, offsetof(Config, DlssReactiveMaskBias),
                          offsetof(CustomOptional<float>, defaultValue), &reactiveBias, sizeof(reactiveBias)))
        return false;
    return shortcut == VK_INSERT && fpsShortcut == VK_PRIOR && fgShortcut == VK_END &&
        fontSize == 14.0f && sharpness == 0.4f && reactiveBias == 0.45f &&
        ConfigPointerMatches(config);
}

static bool ReadConfigBool(uintptr_t config, size_t offset, bool* value) {
    BYTE optional[6];
    if (!value || !ConfigReadAt(config, offset, optional, sizeof(optional))) return false;
    if (optional[1] > 1 || optional[2] > 1 || optional[4] > 1 || optional[5] > 1 ||
        (optional[1] && optional[0] > 1) || (optional[4] && optional[3] > 1)) return false;
    *value = optional[1] ? optional[0] != 0 : optional[2] != 0;
    return true;
}

