// MSVC-ABI-compatible stand-ins for the standard library types OptiScaler's
// Config object is built from.
//
// OptiScaler ships as an MSVC build; this ASI is cross-compiled with clang for
// the MinGW target, whose libstdc++/libc++ lay these types out differently. We
// therefore never include <string>/<optional> in the mirror: we reproduce the
// MSVC layouts below and let the compiler compute offsets from them.
//
// Layout notes (MSVC STL, x64):
//   basic_string : union { CharT buf[16/sizeof(CharT)]; CharT* ptr; }, size, capacity
//   optional<T>  : union { char dummy; T value; }, bool engaged   (value first)
//   filesystem::path : a single wstring
// MSVC does not reuse a base class's tail padding for derived members, so the
// std::optional base of CustomOptional is modelled as a leading member.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace optimirror {

typedef uint16_t wchar16;

struct msvc_string {
    union {
        char buf[16];
        char* ptr;
    } bx;
    size_t size;
    size_t capacity;

    const char* data() const { return capacity <= 15 ? bx.buf : bx.ptr; }

    /**
     * Overwrite the contents without ever allocating or freeing.
     *
     * MSVC's string was allocated by OptiScaler's CRT; this plugin links a
     * different one, so growing the string -- or letting it free the old
     * buffer -- would hand a pointer to the wrong heap. Instead the text is
     * only ever written into storage that already exists: the inline buffer
     * when the string is still small (which every OptiScaler backend code and
     * upscaler id is), or the existing heap block when the new text fits in
     * the capacity already reserved. Anything longer is refused.
     */
    bool assign_in_place(const char* text, size_t len) {
        char* dest;
        if (capacity <= 15) {
            if (len > 15) return false;
            capacity = 15;  // normalise: MSVC keeps 15 for every inline string
            dest = bx.buf;
        } else {
            if (len > capacity) return false;
            dest = bx.ptr;
            if (!dest) return false;
        }
        for (size_t i = 0; i < len; i++) dest[i] = text[i];
        dest[len] = 0;
        size = len;
        return true;
    }
};

struct msvc_wstring {
    union {
        wchar16 buf[8];
        wchar16* ptr;
    } bx;
    size_t size;
    size_t capacity;

    const wchar16* data() const { return capacity <= 7 ? bx.buf : bx.ptr; }
};

// std::filesystem::path is a lone wstring on MSVC.
struct msvc_path {
    msvc_wstring text;
};

template <class T> struct msvc_optional {
    T value;
    bool engaged;
};

// OptiScaler's CustomOptional<T> : public std::optional<T>, plus three members.
template <class T> struct CustomOptional {
    msvc_optional<T> base;
    T defaultValue;
    msvc_optional<T> configIni;
    bool isVolatile;

    bool has_value() const { return base.engaged; }
    T value_or_default() const { return base.engaged ? base.value : defaultValue; }

    // Matches CustomOptional::operator=, which sets the value and clears the
    // volatile flag so the change is saved with the rest of the config.
    void assign(const T& v) {
        base.value = v;
        base.engaged = true;
        isVolatile = false;
    }
};

// std::vector<T> on MSVC: three pointers.
struct msvc_vector_raw {
    void* first;
    void* last;
    void* end;
};

} // namespace optimirror
