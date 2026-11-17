#!/usr/bin/env python3
"""Check the pinned live addresses and hook bytes against the actual bundled DLL."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'py_modules'))
from optiscaler import constants, payload


def verify(core, profile):
    data = Path(core).read_bytes()
    if hashlib.sha256(data).hexdigest() != profile['core_sha256']:
        raise ValueError('Core checksum differs from the live profile')
    pe = struct.unpack_from('<I', data, 60)[0]
    if data[pe:pe + 4] != b'PE\0\0':
        raise ValueError('Invalid core PE header')
    machine, count, timestamp = struct.unpack_from('<HHI', data, pe + 4)
    optional_size = struct.unpack_from('<H', data, pe + 20)[0]
    size = struct.unpack_from('<I', data, pe + 24 + 56)[0]
    if (machine, timestamp, size) != tuple(profile['pe'][k] for k in
                                          ('machine', 'timestamp', 'size_of_image')):
        raise ValueError('Core PE identity differs from the live profile')
    image_base = struct.unpack_from('<Q', data, pe + 24 + 24)[0]
    sections = []
    for i in range(count):
        offset = pe + 24 + optional_size + i * 40
        virtual_size, rva, raw_size, raw = struct.unpack_from('<IIII', data, offset + 8)
        flags = struct.unpack_from('<I', data, offset + 36)[0]
        sections.append((rva, max(virtual_size, raw_size), raw, raw_size, flags))

    def at(rva, length, execute=False):
        for start, extent, raw, raw_size, flags in sections:
            if start <= rva and rva + length <= start + extent:
                if execute and not flags & 0x20000000:
                    raise ValueError(f'Hook outside executable section: {rva:#x}')
                delta = rva - start
                if delta + length > raw_size:
                    raise ValueError(f'Address has no file bytes: {rva:#x}')
                return data[raw + delta:raw + delta + length]
        raise ValueError(f'Address outside image sections: {rva:#x}')

    # Read RSDS from a PE debug directory entry, rather than an arbitrary string.
    debug_rva, debug_size = struct.unpack_from('<II', data, pe + 24 + 112 + 6 * 8)
    identities = []
    for offset in range(0, debug_size, 28):
        entry = at(debug_rva + offset, 28)
        kind, length, rva = struct.unpack_from('<III', entry, 12)
        if kind == 2:
            record = at(rva, length)
            if record[:4] == b'RSDS':
                identities.append((record[4:20].hex(), struct.unpack_from('<I', record, 20)[0]))
    identity = (profile['rsds']['guid_bytes'], profile['rsds']['age'])
    if identity not in identities or str(uuid.UUID(bytes_le=bytes.fromhex(identity[0]))) != profile['rsds']['guid']:
        raise ValueError('Core debug identity differs from the live profile')
    for name, hook in profile['hook'].items():
        expected = bytes.fromhex(hook['prologue'])
        if at(hook['rva'], len(expected), execute=True) != expected:
            raise ValueError(f'Hook bytes differ: {name}')
    bootstrap = profile['bootstrap']
    for rva, value in [(bootstrap['return_rva'], bootstrap['return_prologue']),
                       (bootstrap['return_rva'] - len(bytes.fromhex(bootstrap['call_before_return'])),
                        bootstrap['call_before_return'])]:
        expected = bytes.fromhex(value)
        if at(rva, len(expected), execute=True) != expected:
            raise ValueError('ASI bootstrap callsite differs')
    for rva in profile['rva'].values():
        # Uninitialized globals can live beyond a section's file-backed bytes.
        if not any(start <= rva < start + extent and flags & 0x80000000
                   for start, extent, _, _, flags in sections):
            raise ValueError(f'Live global outside writable image memory: {rva:#x}')
    def locator(vtable, physical, class_name, cd_offset=4):
        pointer = struct.unpack('<Q', at(vtable - 8, 8))[0] - image_base
        signature, offset, cd, type_rva, _, self_rva = struct.unpack('<6I', at(pointer, 24))
        if (signature, offset, cd, self_rva) != (1, physical, cd_offset, pointer):
            raise ValueError(f'RTTI layout differs: {class_name}')
        expected_name = f'.?AV{class_name}@@'.encode() + b'\0'
        if at(type_rva + 16, len(expected_name)) != expected_name:
            raise ValueError(f'RTTI class differs: {class_name}')

    for item in profile['backend_types']:
        locator(item['interface_vtable_rva'], item['physical_offset'],
                item['class_name'], item['cd_offset'])
    for group, class_name in [('fg_offsets', 'FSRFG_Dx12'),
                               ('xefg_offsets', 'XeFG_Dx12')]:
        entry = profile[group]
        locator(entry['dx12_vtable_rva'], entry['dx12_subobject'], class_name)
        locator(entry['virtual_vtable_rva'], entry['virtual_base'], class_name)
        if struct.unpack('<2i', at(entry['dx12_vbtable_rva'], 8)) != (-8, entry['virtual_base'] - entry['dx12_subobject'] - 8):
            raise ValueError(f'FG DX12 virtual-base table differs: {class_name}')
        if struct.unpack('<2i', at(entry['root_vbtable_rva'], 8)) != (0, entry['virtual_base']):
            raise ValueError(f'FG root virtual-base table differs: {class_name}')
    print('Bundled DLL identity, live addresses, hooks, bootstrap and RTTI: PASS')


def main():
    profile = json.loads((ROOT / 'defaults/live-profile.json').read_text())
    if len(sys.argv) == 2:
        verify(Path(sys.argv[1]), profile)
    else:
        with tempfile.TemporaryDirectory(prefix='decky-profile-verification-') as tmp:
            stage = Path(tmp) / 'runtime'
            archive = ROOT / 'bin' / constants.PAYLOAD_ARCHIVE
            if payload.sha256(archive) != constants.PAYLOAD_SHA256:
                raise ValueError('Runtime archive checksum mismatch')
            payload.extract_archive(archive, stage)
            verify(stage / 'OptiScaler.dll', profile)


if __name__ == '__main__':
    main()
