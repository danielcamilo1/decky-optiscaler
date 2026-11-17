// Production live control for the exact OptiScaler 0.9.5 profile.
// Only RenderMenu's boundary accesses mutable core state. The file worker
// exchanges bounded value snapshots with it; neither CRT owns the other's data.
#define __USE_MINGW_ANSI_STDIO 1
#include <windows.h>
#include <dxgi.h>
#include <psapi.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <wchar.h>
#include "msvc_abi.h"
#include "generated/config_mirror.h"
#include "generated/runtime_profile.h"
#include "generated/pdb_assertions.h"
using namespace optimirror;
using namespace runtime_profile;
namespace live {
static_assert(sizeof(void*) == 8, "x64 required");
static_assert(sizeof(Config) == sizes_config, "release Config ABI");
static_assert(sizeof(CustomOptional<bool>) == 6, "MSVC optional bool ABI");
static_assert(sizeof(CustomOptional<uint32_t>) == 24, "MSVC optional scalar ABI");
static_assert(sizeof(msvc_deque_raw) == sizes_deque_double, "release deque ABI");
static_assert(offsetof(DXGI_ADAPTER_DESC, VendorId) == 256, "Windows SDK DXGI_ADAPTER_DESC layout");
static_assert(offsetof(Config, FGEnabled) == 5860, "release FG offset");
static_assert(offsetof(Config, fileName) == 6640, "release Config end");
static const DWORD kExpectedTimestamp = pe_timestamp;
static const DWORD kExpectedSizeOfImage = pe_size_of_image;
static const DWORD kExpectedPdbAge = rsds_age;
static const DWORD kConfigPointerRva = rva_config_pointer;
static const DWORD kStateRva = rva_state_instance;
static const DWORD kFrameCountOffset = state_offsets_frameCount;
static const auto& kExpectedPdbGuid = rsds_guid_bytes;
static const size_t kMaxSections = 16;
struct SectionRange { DWORD start, size; };
struct Sha256 { uint32_t state[8]; uint64_t bitCount; BYTE block[64]; size_t used; };
static HMODULE g_self, g_core;
static BYTE* g_coreBase;
static DWORD g_coreImageSize;
static SectionRange g_dataSections[kMaxSections];
static size_t g_dataSectionCount;
static bool g_coreValid, g_coreHashValid;
#include "identity.h"

constexpr size_t MAX_OPS = limits_operations, MAX_VERSIONS = limits_versions;
enum Kind { BOOL, I32, F32, BACKEND, FG_INDEX, FFX_INDEX };
struct Field { const char* member; const char* key; Kind kind; size_t offset, size; };
#define F(M,K,T,C) {#M,K,T,offsetof(Config,M),sizeof(CustomOptional<C>)}
static const Field fields[] = {
 F(FGEnabled,"FrameGen.Enabled",BOOL,bool), F(FGHUDFix,"OptiFG.HUDFix",BOOL,bool),
 F(FGDebugView,"FrameGen.DebugView",BOOL,bool), F(FGMakeDepthCopy,"OptiFG.MakeDepthCopy",BOOL,bool),
 F(FGHUDFixExtended,"OptiFG.HUDFixExtended",BOOL,bool),
 F(FGXeFGInterpolationCount,"XeFG.InterpolationCount",I32,int32_t),
 F(FfxFGIndex,"FSR.FGIndex",FG_INDEX,int32_t), F(FfxUpscalerIndex,"FSR.UpscalerIndex",FFX_INDEX,int32_t),
 F(Dx11Upscaler,"Upscalers.Dx11Upscaler",BACKEND,msvc_string),
 F(Dx12Upscaler,"Upscalers.Dx12Upscaler",BACKEND,msvc_string),
 F(VulkanUpscaler,"Upscalers.VulkanUpscaler",BACKEND,msvc_string),
 F(OverrideSharpness,"Sharpness.OverrideSharpness",BOOL,bool),
 F(Sharpness,"Sharpness.Sharpness",F32,float), F(ShowFps,"Menu.ShowFps",BOOL,bool)
};
#undef F
struct Operation { unsigned field; Kind kind; int32_t integer; float real; char text[16]; };
struct Batch { uint64_t seq,directoryGeneration; char session[80], api[12], generation[32]; unsigned count; Operation ops[MAX_OPS]; };
struct Versions { unsigned count; uint64_t ids[MAX_VERSIONS]; char names[MAX_VERSIONS][64]; };
struct Snapshot {
 bool valid, frameReady, scalar, backend, fg, fgCanEnable, ffx, fgVersion, xefgCount, optiFg, hudFix, fsrDebug,dirVerified;
 bool canOverrideSharpness, dlssMajorKnown, dlssEnabled, intelD3D11;uint64_t directoryGeneration;
 unsigned api,rawApi,swapchainApi, backendEntries, activeFgOutput,activeFgInput,workingMode,d3d11VendorId,dlssMajor; uintptr_t fgSwapchain;
 uintptr_t config, feature, currentFg, fgSwapContext;
 unsigned fgObjectKind; bool fgActive;
 bool featureInited, featureFrozen, fgChanged, scChanged, clearHud;
 uint32_t featureFrames; uint64_t frames, fgFrames;
 int fgEnabled, fgIndex, ffxIndex, xefgMax;uint32_t fgConstantsFlags,renderWidth,displayWidth,swapchainFormat;uint64_t gameQuirks;bool exclusiveFullscreen,hdrActive;
 char dx11[16], dx12[16], vk[16], actualBackend[16],pending[16], generation[32],switchableBackends[128];
 Versions fgVersions, upVersions;
 double renderedMs, presentedMs,presentCounterFps; bool telemetryReady;ULONGLONG featureProgressTick;
};
struct Result { uint64_t seq,directoryGeneration; char session[80],api[12],generation[32]; char ack[24], error[96], accepted[1024], failed[1024]; unsigned acceptedCount; };
static SRWLOCK g_lock = SRWLOCK_INIT;
static Snapshot g_snapshot;
static Result g_result;
static Batch g_queued;
static bool g_hasQueued;
static ULONGLONG g_queuedSince, g_lastFrame;
static char g_session[80],g_exeName[MAX_PATH*4];
static LONG g_started, g_inCallback, g_callbackAuthorized;
static bool g_hookInstalled;
static const char* g_startError = "";
static wchar_t g_parentDirectory[MAX_PATH], g_commandPath[MAX_PATH], g_statusPath[MAX_PATH], g_logPath[MAX_PATH];
static uint64_t g_lastSequence;
static uintptr_t g_telemetryFeature;static uint32_t g_telemetryFeatureFrames;
static uint64_t g_telemetryStateFrames;static ULONGLONG g_telemetryTick,g_featureProgressTick,g_presentProgressTick;
static double g_presentCounterFps,g_lastRenderedInterval,g_lastPresentedInterval;
static ULONGLONG g_renderedIntervalTick,g_presentedIntervalTick;
static bool (*g_renderMenu)();
static bool JoinPath(wchar_t*,const wchar_t*);
#include "directory.h"

static bool Token(const char* t, size_t max) {
 size_t n = strlen(t); if (!n || n >= max) return false;
 for (size_t i=0;i<n;++i) if (!((t[i]>='a'&&t[i]<='z')||(t[i]>='A'&&t[i]<='Z')||(t[i]>='0'&&t[i]<='9')||t[i]=='-'||t[i]=='_')) return false;
 return true;
}
static bool ParseUnsigned64(const char* t, size_t n, uint64_t* out) {
 if (!n || !out) return false; uint64_t v=0;
 for (size_t i=0;i<n;++i) { if(t[i]<'0'||t[i]>'9') return false; unsigned d=t[i]-'0'; if(v>(UINT64_MAX-d)/10) return false; v=v*10+d; }
 *out=v; return true;
}
static int FindField(const char* name) { for(unsigned i=0;i<sizeof(fields)/sizeof(fields[0]);++i) if(!strcmp(fields[i].member,name)) return (int)i; return -1; }
static const char* ApiName(unsigned api) { return api==1?"dx11":api==2?"dx12":api==3?"vulkan":"unknown"; }
static unsigned ApiCode(const char* api) { return !strcmp(api,"dx11")?1:!strcmp(api,"dx12")?2:!strcmp(api,"vulkan")?3:0; }
static unsigned BackendField(unsigned api) { return api==1?8:api==2?9:10; }
static bool BackendCode(const char* t, unsigned api) {
 for(const auto& type:backend_types)if(type.api==api&&!strcmp(type.code,t))return true;
 return false;
}
static bool MenuBackendAllowed(const Snapshot& s,const char* code) {
 if(!s.backend||!strcmp(s.actualBackend,"dlssd")||!BackendCode(code,s.api)||!strcmp(code,"dlssd"))return false;
 if(!strcmp(code,"dlss")&&!s.dlssEnabled)return false;
 if(s.api==1&&!strcmp(code,"xess")&&!s.intelD3D11)return false;
 if(s.api==1)return !strcmp(code,"xess")||!strcmp(code,"fsr22")||!strcmp(code,"fsr31")||
  !strcmp(code,"xess_12")||!strcmp(code,"fsr21_12")||!strcmp(code,"fsr22_12")||!strcmp(code,"fsr31_12")||!strcmp(code,"dlss");
 if(s.api==2)return !strcmp(code,"xess")||!strcmp(code,"fsr21")||!strcmp(code,"fsr22")||
  !strcmp(code,"fsr31")||!strcmp(code,"dlss");
 if(s.api==3)return !strcmp(code,"xess")||!strcmp(code,"fsr21")||!strcmp(code,"fsr22")||
  !strcmp(code,"fsr31")||!strcmp(code,"dlss")||!strcmp(code,"fsr21_12")||!strcmp(code,"fsr31_12");
 return false;
}
static void AddSwitchableBackend(Snapshot* s,const char* code) {
 if(!MenuBackendAllowed(*s,code))return;
 size_t n=strlen(s->switchableBackends),m=strlen(code);
 if(n+m+(n?1:0)+1>sizeof(s->switchableBackends))return;
 if(n)s->switchableBackends[n++]='|';memcpy(s->switchableBackends+n,code,m+1);
}
static void BuildSwitchableBackends(Snapshot* s) {
 if(s->api==1) {
  const char* candidates[]={"xess","fsr22","fsr31","xess_12","fsr21_12","fsr22_12","fsr31_12","dlss"};
  for(const char* code:candidates)AddSwitchableBackend(s,code);
 } else if(s->api==2) {
  const char* candidates[]={"xess","fsr21","fsr22","fsr31","dlss"};
  for(const char* code:candidates)AddSwitchableBackend(s,code);
 } else if(s->api==3) {
  const char* candidates[]={"xess","fsr21","fsr22","fsr31","dlss","fsr21_12","fsr31_12"};
  for(const char* code:candidates)AddSwitchableBackend(s,code);
 }
}
static bool Dynamic(const Batch& b) { for(unsigned i=0;i<b.count;++i) if(b.ops[i].kind>=BACKEND) return true; return false; }
// Fixed header order and one operation per key. No comments, blank lines,
// embedded NUL/CR, extra tokens, conversion suffixes, or implicit auto=false.
static bool ParseBatch(const char* input,size_t length,Batch* b,const char** error) {
 *error="bad_command"; memset(b,0,sizeof(*b));
 if(!input||!length||length>limits_command_bytes||input[length-1]!='\n') return false;
 char text[limits_command_bytes+1]; memcpy(text,input,length); text[length]=0;
 for(size_t i=0;i<length;++i) if(!input[i]||input[i]=='\r'||input[i]=='\t'||((unsigned char)input[i]<32&&input[i]!='\n')||(unsigned char)input[i]>126) return false;
 char* cursor=text; unsigned lineNo=0; bool seen[14]={};
 while(*cursor) {
  char* line=cursor; char* nl=strchr(cursor,'\n'); if(!nl) return false; *nl=0;cursor=nl+1;
  if(!*line) return false;
  char* tokens[5]={}; unsigned n=0;
  char* p=line; while(*p) { if(n==5||*p==' ') return false; tokens[n++]=p; char* end=strchr(p,' '); if(!end) break; *end=0;p=end+1;if(!*p) return false; }
  if(lineNo<5) {
   static const char* names[]={"schema","session","seq","api","generation"};
   if(n!=2||strcmp(tokens[0],names[lineNo])) return false;
   if(lineNo==0&&strcmp(tokens[1],"7")) return false;
   if(lineNo==1) { if(!Token(tokens[1],sizeof(b->session))) return false; strcpy(b->session,tokens[1]); }
   if(lineNo==2&&!ParseUnsigned64(tokens[1],strlen(tokens[1]),&b->seq)) { *error="bad_sequence";return false; }
   if(lineNo==3) { if(strcmp(tokens[1],"unknown")&&!ApiCode(tokens[1])) return false;strcpy(b->api,tokens[1]); }
   if(lineNo==4) { if(!Token(tokens[1],sizeof(b->generation))) return false;strcpy(b->generation,tokens[1]); }
  } else {
   if(b->count==MAX_OPS) return false;
   Operation op={}; int f=-1;
   if(!strcmp(tokens[0],"set")) {
    if(n!=4||(f=FindField(tokens[1]))<0||fields[f].kind>=BACKEND) return false;
    op.kind=fields[f].kind;
    if(op.kind==BOOL) { if(strcmp(tokens[2],"bool")||(strcmp(tokens[3],"0")&&strcmp(tokens[3],"1"))) return false;op.integer=tokens[3][0]-'0'; }
    if(op.kind==I32) { uint64_t v; if(strcmp(tokens[2],"i32")||!ParseUnsigned64(tokens[3],strlen(tokens[3]),&v)||v>INT32_MAX) return false;op.integer=(int32_t)v; }
    if(op.kind==F32) { char* end; if(strcmp(tokens[2],"f32")) return false;op.real=strtof(tokens[3],&end);if(end==tokens[3]||*end||!isfinite(op.real)||op.real<0||op.real>1.3f) return false; }
   } else if(n==2&&!strcmp(tokens[0],"backend")) {
    unsigned api=ApiCode(b->api);if(!BackendCode(tokens[1],api)) return false; f=BackendField(api);op.kind=BACKEND;strcpy(op.text,tokens[1]);
   } else if(n==2&&(!strcmp(tokens[0],"fgindex")||!strcmp(tokens[0],"ffxupscaler"))) {
    uint64_t v; if(!ParseUnsigned64(tokens[1],strlen(tokens[1]),&v)||v>=MAX_VERSIONS) return false;
    f=!strcmp(tokens[0],"fgindex")?6:7;op.kind=fields[f].kind;op.integer=(int32_t)v;
   } else return false;
   op.field=(unsigned)f;if(seen[f]) return false;seen[f]=true;b->ops[b->count++]=op;
  }
  ++lineNo;
 }
 if(lineNo<6||!b->seq) return false;
 if(!strcmp(b->generation,"none")||(Dynamic(*b)&&!ApiCode(b->api))) { *error="selection_context_required"; return false; }
 return true;
}

static bool Utf8(const wchar_t* source,char* output,size_t capacity) {
 if(!source||!output||!capacity||capacity>INT32_MAX)return false;
 return WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,source,-1,output,(int)capacity,NULL,NULL)>0;
}
static bool ReadString(const msvc_string* source,char* out,size_t capacity) {
 msvc_string s; if(!ReadBytes(source,&s,sizeof(s))||s.capacity<15||s.capacity<s.size||s.size>=capacity) return false;
 const char* data=s.capacity<=15?(const char*)source:s.bx.ptr;
 if(!ReadBytes(data,out,s.size+1)||out[s.size]||strlen(out)!=s.size) return false;
 for(size_t i=0;i<s.size;++i) if((unsigned char)out[i]<32||(unsigned char)out[i]==127||out[i]=='|') return false;
 return !s.size||MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,out,(int)s.size,NULL,0)>0;
}
template<class T> static bool ReadOption(uintptr_t c,size_t off,T* out) {
 CustomOptional<T> o;if(!ConfigReadAt(c,off,&o,sizeof(o))||*(BYTE*)&o.base.engaged>1) return false;
 *out=o.value_or_default();return true;
}
static bool ReadOption(uintptr_t c,size_t off,bool* out) { return ReadConfigBool(c,off,out); }
template<class T> static bool ResetOptionalWritable(uintptr_t c,size_t off) {
 CustomOptional<T> o;
 if(!ConfigReadAt(c,off,&o,sizeof(o))||*(BYTE*)&o.base.engaged>1)return false;
 return CheckMemory((void*)(c+off+offsetof(CustomOptional<T>,base)+offsetof(msvc_optional<T>,engaged)),sizeof(bool),true);
}
template<class T> static bool OptionalIsReset(uintptr_t c,size_t off) {
 CustomOptional<T> o;
 return ConfigReadAt(c,off,&o,sizeof(o))&&*(BYTE*)&o.base.engaged==0;
}
static bool OverrideSharpnessChanged(const Batch& b,const Snapshot& s,bool* changed) {
 *changed=false;
 for(unsigned i=0;i<b.count;++i)if(b.ops[i].field==11) {
  bool current=false;if(!ReadOption(s.config,offsetof(Config,OverrideSharpness),&current))return false;
  *changed=current!=(b.ops[i].integer!=0);break;
 }
 return true;
}
static bool ReadConfigString(uintptr_t c,unsigned field,char* out) {
 CustomOptional<msvc_string> o;if(!ConfigReadAt(c,fields[field].offset,&o,sizeof(o))||*(BYTE*)&o.base.engaged>1) return false;
 const auto* p=(const CustomOptional<msvc_string>*)(c+fields[field].offset);
 return ReadString(o.base.engaged?&p->base.value:&p->defaultValue,out,16);
}
static bool StateRead(size_t offset,void* out,size_t len) { return g_coreValid&&offset<=sizes_state&&len<=sizes_state-offset&&ReadDataRva(kStateRva+(DWORD)offset,out,len); }
template<class T> static bool StateRead(size_t offset,T* out) { return StateRead(offset,out,sizeof(T)); }
static bool Flag(size_t off,bool* out) { BYTE b;if(!StateRead(off,&b)||b>1)return false;*out=b!=0;return true; }
struct BackendEntry { uint32_t handle; BYTE changed,pad[3]; };
struct DenseTable { msvc_vector_raw values,buckets; size_t max;float load;BYTE hash,equal,shifts,pad; };
static_assert(sizeof(DenseTable)==64,"pinned unordered_dense layout");
static bool Vector(const msvc_vector_raw& v,size_t stride,size_t limit,size_t* count) {
 uintptr_t a=(uintptr_t)v.first,b=(uintptr_t)v.last,c=(uintptr_t)v.end;
 if(!a&&!b&&!c){*count=0;return true;}
 if(!a||b<a||c<b||(b-a)%stride||(c-a)%stride||(c-a)/stride>limit) return false;
 *count=(b-a)/stride;return c==a||CheckMemory((void*)a,c-a,false);
}
static bool Backends(DenseTable* out,BackendEntry** entries,unsigned* count,bool write=false) {
 if(!StateRead(state_offsets_changeBackend,out)) return false;
 size_t n,bc;if(out->load!=0.8f||out->shifts<1||out->shifts>62||!Vector(out->values,8,limits_backend_entries,&n)||!Vector(out->buckets,8,4096,&bc)||n>out->max) return false;
 if((!bc&&out->max)||(bc&&(bc!=(uint64_t(1)<<(64-out->shifts))||out->max!=(size_t)((float)bc*0.8f)))) return false;
 *entries=(BackendEntry*)out->values.first;*count=(unsigned)n;
 for(size_t i=0;i<n;++i) if((*entries)[i].changed>1) return false;
 return !write||!n||CheckMemory(*entries,n*sizeof(BackendEntry),true);
}
static bool ReadVersions(size_t namesOff,size_t idsOff,Versions* out) {
 memset(out,0,sizeof(*out));msvc_vector_raw names,ids;size_t n,m;
 if(!StateRead(namesOff,&names)||!StateRead(idsOff,&ids)||!Vector(names,8,MAX_VERSIONS,&n)||!Vector(ids,8,MAX_VERSIONS,&m)||n!=m) return false;
 for(size_t i=0;i<n;++i) {
  const char* text; if(!ReadBytes((const char**)names.first+i,&text,8)||!ReadBytes((uint64_t*)ids.first+i,&out->ids[i],8)) return false;
  bool ended=false;for(size_t j=0;j<64;++j) { char ch;if(!ReadBytes(text+j,&ch,1)) return false;if(!ch){ended=j>0;break;}if((unsigned char)ch<32||(unsigned char)ch>126||ch=='|') return false;out->names[i][j]=ch; }
  if(!ended) return false;
 }
 out->count=(unsigned)n;return true;
}
static void Generation(Snapshot* s) {
 // Stable FNV-1a over ordered IDs, API and capability sources. Reorders matter.
 uint64_t h=14695981039346656037ull;
 auto add=[&](uint64_t v){for(int i=0;i<8;++i){h^=(BYTE)(v>>(8*i));h*=1099511628211ull;}};
 auto addText=[&](const char* text){while(*text)add((BYTE)*text++);add(0xff);};
 add(s->directoryGeneration);add(s->api);add(s->rawApi);add(s->swapchainApi);add(s->backendEntries);add(s->activeFgInput);add(s->activeFgOutput);add(s->workingMode);
 add((uint64_t)s->feature);add((uint64_t)s->currentFg);add((uint64_t)s->fgSwapchain);add((uint64_t)s->fgSwapContext);add(s->featureInited);add(s->featureFrozen);
 add(s->fgObjectKind);add(s->fgConstantsFlags);add(s->xefgMax);add(s->d3d11VendorId);add(s->dlssEnabled);add(s->dlssMajorKnown);add(s->dlssMajor);
 add(s->backend);add(s->canOverrideSharpness);add(s->fg);add(s->fgCanEnable);add(s->fgVersion);add(s->ffx);add(s->xefgCount);add(s->optiFg);add(s->hudFix);add(s->fsrDebug);addText(s->actualBackend);addText(s->switchableBackends);
 add(s->upVersions.count);for(unsigned i=0;i<s->upVersions.count;++i)add(s->upVersions.ids[i]);
 add(s->fgVersions.count);for(unsigned i=0;i<s->fgVersions.count;++i)add(s->fgVersions.ids[i]);
 snprintf(s->generation,sizeof(s->generation),"%016llx",(unsigned long long)h);
}
static bool FgObject(Snapshot* s) {
 if(!s->currentFg)return false;
 bool fsr=s->activeFgOutput==2,xe=s->activeFgOutput==4;if(!fsr&&!xe)return false;
 size_t physical=fsr?fg_offsets_dx12_subobject:xefg_offsets_dx12_subobject;
 size_t base=fsr?fg_offsets_virtual_base:xefg_offsets_virtual_base;
 if(s->currentFg<physical)return false;uintptr_t complete=s->currentFg-physical;
 uintptr_t p=0,v=0,vb=0,root=0;int32_t displacement=1,baseDisplacement=1;
 if(!ReadBytes((void*)s->currentFg,&p,8)||p!=(uintptr_t)g_coreBase+(fsr?fg_offsets_dx12_vtable_rva:xefg_offsets_dx12_vtable_rva)||
    !ReadBytes((void*)(complete+base),&v,8)||v!=(uintptr_t)g_coreBase+(fsr?fg_offsets_virtual_vtable_rva:xefg_offsets_virtual_vtable_rva)||
    !ReadBytes((void*)(s->currentFg+8),&vb,8)||vb!=(uintptr_t)g_coreBase+(fsr?fg_offsets_dx12_vbtable_rva:xefg_offsets_dx12_vbtable_rva)||
    !ReadBytes((void*)complete,&root,8)||root!=(uintptr_t)g_coreBase+(fsr?fg_offsets_root_vbtable_rva:xefg_offsets_root_vbtable_rva)||
    !ReadBytes((void*)(s->currentFg-4),&displacement,4)||displacement!=0||
    !ReadBytes((void*)(complete+base-4),&baseDisplacement,4)||baseDisplacement!=0)return false;
 BYTE active=0,waiting=0;uint64_t frames=0,target=0;
 if(!ReadBytes((void*)(complete+8),&s->fgSwapContext,8)||
    !ReadBytes((void*)(complete+base+ifg_state_active),&active,1)||active>1||
    !ReadBytes((void*)(complete+base+ifg_state_waiting),&waiting,1)||waiting>1||
    !ReadBytes((void*)(complete+base+ifg_state_frames),&frames,8)||
    !ReadBytes((void*)(complete+base+ifg_state_target),&target,8)||
    !ReadBytes((void*)(complete+base+xefg_gates_ifg_constants_flags),&s->fgConstantsFlags,xefg_gates_flags_size))return false;
 s->fgActive=(active||waiting)&&!(target&&target>=frames);s->fgObjectKind=fsr?2:4;
 return true;
}
static bool FfxBackend(unsigned api,const char* code) {
 return api==1?!strcmp(code,"fsr31_12"):api==2?!strcmp(code,"fsr31"):api==3?(!strcmp(code,"fsr31_12")||!strcmp(code,"fsr31")):false;
}
static bool BackendIdentity(Snapshot* s) {
 uintptr_t vptr=0;if(!s->feature||!ReadBytes((void*)s->feature,&vptr,sizeof(vptr)))return false;
 for(const auto& type:backend_types) {
  if(type.api!=s->api||vptr!=(uintptr_t)g_coreBase+type.interface_vtable_rva)continue;
  if(s->feature<type.physical_offset)return false;
  if(type.cd_offset){int32_t displacement=1;if(!ReadBytes((void*)(s->feature-type.cd_offset),&displacement,4)||displacement)return false;}
  strcpy(s->actualBackend,type.code);return true;
 }
 return false;
}
static bool Capture(Snapshot* s) {
 memset(s,0,sizeof(*s));uintptr_t c=0;
 // An observed invalid pointer/path is an authorization event even when the
 // Config layout cannot be read. A -> NULL -> A cannot preserve the old grant.
 if(!g_coreValid||!ReadConfigPointer(&c)){RevokeDirectoryAuth();return false;}
 bool authorized=DirectoryAuthMatches(c);s->config=c;s->dirVerified=authorized;s->directoryGeneration=g_directoryAuth.generation;
 if(!c||!ValidateConfigAt(c)){RevokeDirectoryAuth();s->dirVerified=false;s->directoryGeneration=g_directoryAuth.generation;return false;}
 char exe[MAX_PATH*4],scratch[MAX_PATH*4];
 if(!ReadString((msvc_string*)(g_coreBase+kStateRva),exe,sizeof(exe))||!g_exeName[0]||_stricmp(exe,g_exeName)||
    !ReadString((msvc_string*)(g_coreBase+kStateRva+32),scratch,sizeof(scratch))||
    !ReadString((msvc_string*)(g_coreBase+kStateRva+64),scratch,sizeof(scratch)))return false;
 bool shutting=false;if(!Flag(state_offsets_isShuttingDown,&shutting)||shutting)return false;
 if(!StateRead(state_offsets_api,&s->rawApi)||s->rawApi>3||!StateRead(state_offsets_swapchainApi,&s->swapchainApi)||s->swapchainApi>3||!StateRead(state_offsets_currentFeature,&s->feature)||!StateRead(state_offsets_currentFG,&s->currentFg)||!StateRead(state_offsets_activeFgOutput,&s->activeFgOutput)||!StateRead(state_offsets_activeFgInput,&s->activeFgInput)||!StateRead(state_offsets_currentFGSwapchain,&s->fgSwapchain)||!StateRead(state_offsets_workingMode,&s->workingMode))return false;
 s->api=s->rawApi?s->rawApi:s->swapchainApi;
 if(s->feature) {
  BYTE init=0,frozen=0;
  if(!ReadBytes((BYTE*)s->feature+feature_offsets_is_inited,&init,1)||init>1||!ReadBytes((BYTE*)s->feature+feature_offsets_frozen,&frozen,1)||frozen>1||!ReadBytes((BYTE*)s->feature+feature_offsets_frame_count,&s->featureFrames,4)) return false;
  s->featureInited=init;s->featureFrozen=frozen;
  if(!ReadBytes((BYTE*)s->feature+feature_offsets_render_width,&s->renderWidth,4)||!ReadBytes((BYTE*)s->feature+feature_offsets_display_width,&s->displayWidth,4))return false;
 }
 if(!Flag(state_offsets_FGchanged,&s->fgChanged)||!Flag(state_offsets_SCchanged,&s->scChanged)||!Flag(state_offsets_ClearCapturedHudlesses,&s->clearHud)||!StateRead(state_offsets_frameCount,&s->frames)||!StateRead(state_offsets_FGLastFrame,&s->fgFrames)||!StateRead(state_offsets_xefgMaxInterpolationCount,&s->xefgMax)) return false;
 bool fgEnabled=false;
 if(!ReadOption(c,offsetof(Config,FGEnabled),&fgEnabled)||!ReadOption(c,offsetof(Config,DLSSEnabled),&s->dlssEnabled)||!ReadOption(c,offsetof(Config,FfxFGIndex),&s->fgIndex)||!ReadOption(c,offsetof(Config,FfxUpscalerIndex),&s->ffxIndex)||!ReadConfigString(c,8,s->dx11)||!ReadConfigString(c,9,s->dx12)||!ReadConfigString(c,10,s->vk)||!ReadString((msvc_string*)(g_coreBase+kStateRva+state_offsets_newBackend),s->pending,16)) return false;
 BackendIdentity(s);
 if(!strcmp(s->actualBackend,"dlss")&&s->feature>=dlss_version_behind_interface) {
  s->dlssMajorKnown=ReadBytes((void*)(s->feature-dlss_version_behind_interface+dlss_version_major_offset),&s->dlssMajor,sizeof(s->dlssMajor));
 }
 if(s->api==1) {
  if(!StateRead(state_offsets_currentD3D11AdepterDesc+offsetof(DXGI_ADAPTER_DESC,VendorId),&s->d3d11VendorId,sizeof(s->d3d11VendorId)))return false;
  s->intelD3D11=s->d3d11VendorId==0x8086;
 }
 s->fgEnabled=fgEnabled;
 FgObject(s);
 DenseTable table;BackendEntry* entries;if(!Backends(&table,&entries,&s->backendEntries))return false;
 if(!ReadVersions(state_offsets_ffxUpscalerVersionNames,state_offsets_ffxUpscalerVersionIds,&s->upVersions))memset(&s->upVersions,0,sizeof(s->upVersions));
 if(!ReadVersions(state_offsets_ffxFGVersionNames,state_offsets_ffxFGVersionIds,&s->fgVersions))memset(&s->fgVersions,0,sizeof(s->fgVersions));
 StateRead(state_offsets_lastFGFrameTime,&s->renderedMs);StateRead(state_offsets_presentFrameTime,&s->presentedMs);
 if(!isfinite(s->renderedMs)||s->renderedMs<=0||s->renderedMs>1000)s->renderedMs=0;
 if(!isfinite(s->presentedMs)||s->presentedMs<=0||s->presentedMs>1000)s->presentedMs=0;
 s->valid=true;s->frameReady=true;s->scalar=true;
 s->backend=s->api&&s->backendEntries&&s->feature&&s->featureInited&&!s->featureFrozen&&s->actualBackend[0]&&strcmp(s->actualBackend,"dlssd");
 s->canOverrideSharpness=s->feature&&!s->featureFrozen&&s->actualBackend[0]&&(!strcmp(s->actualBackend,"dlss")?s->dlssMajorKnown:true);
 BuildSwitchableBackends(s);
 s->fg=s->fgSwapchain&&s->workingMode!=2&&s->activeFgInput!=0&&s->fgObjectKind&&
  (s->activeFgInput!=5||(s->featureInited&&!s->featureFrozen));
 s->optiFg=s->fg&&s->api==2&&s->activeFgInput==5&&s->featureInited&&!s->featureFrozen;
 bool disabledHud=true;if(!ReadOption(c,offsetof(Config,FGDisableHUDFix),&disabledHud))return false;
 s->hudFix=s->optiFg&&!disabledHud;s->fsrDebug=s->fg&&s->fgObjectKind==2;
 s->fgCanEnable=s->fg;
 if(s->fgObjectKind==4) {
  bool ignore=false;
  if(!Flag(state_offsets_realExclusiveFullscreen,&s->exclusiveFullscreen)||!Flag(state_offsets_isHdrActive,&s->hdrActive)||
     !StateRead(state_offsets_currentSwapchainDesc+xefg_gates_swapchain_format_offset,&s->swapchainFormat)||!StateRead(state_offsets_gameQuirks,&s->gameQuirks)||
     !ReadOption(c,offsetof(Config,FGXeFGIgnoreInitChecks),&ignore))return false;
  bool lowRes=(s->fgConstantsFlags&(uint32_t(1)<<xefg_gates_display_mv_bit))==0;
  bool nativeAA=s->activeFgInput==5&&s->renderWidth==s->displayWidth;
  bool quirk=(s->gameQuirks&(uint64_t(1)<<xefg_gates_quirk_force_render_mv_bit))!=0;
  bool hdr=ignore||!s->hdrActive||s->swapchainFormat==0||s->swapchainFormat>=15;
  // The original menu unconditionally resets FGEnabled for exclusive
  // fullscreen, including Ignore Init Checks. Keep OFF available, reject ON.
  s->fgCanEnable=s->fg&&s->feature&&s->featureInited&&!s->featureFrozen&&s->fgSwapContext&&
   (lowRes||nativeAA||quirk||ignore)&&!s->exclusiveFullscreen&&hdr;
 }
 s->xefgCount=s->fgCanEnable&&s->fgObjectKind==4&&s->fgSwapContext&&s->xefgMax>1;
 s->ffx=s->backend&&s->upVersions.count>0&&FfxBackend(s->api,s->actualBackend);
 // The FFX lists describe available choices. The live index is intentionally
 // unknown because the core exposes no stable runtime selection source here.
 s->fgVersion=s->fg&&s->activeFgOutput==2&&s->fgVersions.count>0;
 Generation(s);return true;
}
static bool StringWritable(msvc_string* s,const char* desired) {
 msvc_string copy;char current[16];size_t n=strlen(desired);
 if(!ReadBytes(s,&copy,sizeof(copy))||!ReadString(s,current,sizeof(current))||n>copy.capacity||!CheckMemory(s,sizeof(*s),true))return false;
 return CheckMemory(copy.capacity<=15?(void*)s:(void*)copy.bx.ptr,n+1,true);
}
static bool ContextMatches(const Batch& b,const Snapshot& s) {
 return strcmp(b.generation,"none")&& !strcmp(b.generation,s.generation)&&(ApiCode(b.api)==s.api||(!Dynamic(b)&&!ApiCode(b.api)));
}
struct Plan { BackendEntry* entries=NULL; unsigned count=0; bool resetReactiveMask=false,reloadSharpness=false; };
static bool EffectiveFg(const Batch& b,const Snapshot& s) {
 bool enabled=s.fgEnabled;for(unsigned i=0;i<b.count;++i)if(b.ops[i].field==0)enabled=b.ops[i].integer!=0;return enabled;
}
static bool Preflight(const Batch& b,const Snapshot& s,const char** error,Plan* plan=NULL) {
 *error="not_ready";
 if(plan)*plan=Plan{};
 if(!s.valid||!s.frameReady||!g_coreValid||strcmp(b.session,g_session))return false;
 if(!s.dirVerified||!DirectoryAuthMatches(s.config)||b.directoryGeneration!=g_directoryAuth.generation||s.directoryGeneration!=g_directoryAuth.generation){*error="directory_authorization_changed";return false;}
 if(!ContextMatches(b,s)){*error="selection_context_changed";return false;}
 // Snapshot all writable destinations before touching any of them.
 bool needBackend=false,needFg=false,needSc=false,needClear=false,reloadSharpness=false,resetReactive=false;
 bool sharpnessChanged=false;
 if(!OverrideSharpnessChanged(b,s,&sharpnessChanged)){*error="invalid_optional";return false;}
 if(sharpnessChanged) {
  if(!s.canOverrideSharpness){*error="sharpness_unavailable";return false;}
  if(!strcmp(s.actualBackend,"dlss")) {
   if(!s.dlssMajorKnown){*error="dlss_version_unavailable";return false;}
   reloadSharpness=s.dlssMajor<3;
  }
 }
 needBackend=reloadSharpness;
 for(unsigned i=0;i<b.count;++i) {
  const auto& op=b.ops[i];if(op.field>=14||op.kind!=fields[op.field].kind){*error="bad_operation";return false;}
  const auto& f=fields[op.field];
  if(!CheckMemory((void*)(s.config+f.offset),f.size,true)){*error="config_unwritable";return false;}
  if(op.kind==BOOL) {
   BYTE v[6];if(!ConfigReadAt(s.config,f.offset,v,6)||v[1]>1||v[2]>1||v[4]>1||v[5]>1||(v[1]&&v[0]>1)||(v[4]&&v[3]>1)){*error="invalid_optional";return false;}
   if(op.integer!=0&&op.integer!=1){*error="bad_boolean";return false;}
   if(op.field==0&&(!s.fg||(op.integer&&!s.fgCanEnable))){*error="fg_activation_unavailable";return false;}
   if((op.field==1||op.field==4)&&!s.hudFix){*error="hud_fix_unavailable";return false;}
   if(op.field==3&&!s.optiFg){*error="opti_fg_unavailable";return false;}
   if(op.field==2&&!s.fsrDebug){*error="fsr_debug_unavailable";return false;}
   if(op.field==0&&op.integer)needFg=true;
   if(op.field==1){needFg=true;needClear=true;}
   if(op.field==2&&EffectiveFg(b,s))needFg=true;
  } else if(op.kind==I32) {
   if(!s.xefgCount||op.integer<1||op.integer>s.xefgMax){*error="xefg_count_unavailable";return false;}
   needFg=true;
  } else if(op.kind==F32) {
   if(!isfinite(op.real)||op.real<0||op.real>1.3f){*error="bad_float";return false;}
  } else if(op.kind==BACKEND) {
   if(!s.backend||op.field!=BackendField(s.api)||!MenuBackendAllowed(s,op.text)){*error="backend_unavailable";return false;}
   needBackend=true;
  } else if(op.kind==FG_INDEX) {
   if(!s.fgVersion||op.integer<0||(unsigned)op.integer>=s.fgVersions.count){*error="fg_version_unavailable";return false;}needFg=true;needSc=true;
  } else if(op.kind==FFX_INDEX) {
   if(!s.backend||op.integer<0||(unsigned)op.integer>=s.upVersions.count){*error="ffx_version_unavailable";return false;}
   // FFX versions belong to the API's FSR31 backend, including D3D11 bridge.
   const char* requested=NULL;for(unsigned j=0;j<b.count;++j)if(b.ops[j].kind==BACKEND)requested=b.ops[j].text;
   if(!requested)requested=s.actualBackend;
   if(!FfxBackend(s.api,requested)){*error="ffx_requires_supported_backend";return false;}
   needBackend=true;
  }
 }
 if(needFg&&!CheckMemory(g_coreBase+kStateRva+state_offsets_FGchanged,1,true))return false;
 if(needSc&&!CheckMemory(g_coreBase+kStateRva+state_offsets_SCchanged,1,true))return false;
 if(needClear&&!CheckMemory(g_coreBase+kStateRva+state_offsets_ClearCapturedHudlesses,1,true))return false;
 if(needBackend) {
  DenseTable table;BackendEntry* entries;unsigned count;
  if(!Backends(&table,&entries,&count,true)||!count){*error="backend_unavailable";return false;}
  if(plan){plan->entries=entries;plan->count=count;}
  const char* code=s.actualBackend;for(unsigned i=0;i<b.count;++i)if(b.ops[i].kind==BACKEND)code=b.ops[i].text;
  if(!StringWritable((msvc_string*)(g_coreBase+kStateRva+state_offsets_newBackend),code)){*error="backend_storage_unwritable";return false;}
  resetReactive=!strcmp(code,"xess")&&strcmp(s.actualBackend,"xess");
  if(resetReactive&&(!ResetOptionalWritable<bool>(s.config,offsetof(Config,DisableReactiveMask))||
                     !ResetOptionalWritable<float>(s.config,offsetof(Config,DlssReactiveMaskBias)))) {
   *error="reactive_mask_storage_unwritable";return false;
  }
 }
 if(plan){plan->resetReactiveMask=resetReactive;plan->reloadSharpness=reloadSharpness;}
 *error="";return true;
}
static void AddKey(char* output,size_t capacity,const char* key) {
 size_t n=strlen(output),k=strlen(key);if(n+k+2>=capacity)return;
 if(n)output[n++]='|';memcpy(output+n,key,k+1);
}
static void Finish(const Batch& b,const char* ack,const char* error) {
 memset(&g_result,0,sizeof(g_result));g_result.seq=b.seq;g_result.directoryGeneration=b.directoryGeneration;
 strcpy(g_result.session,b.session);strcpy(g_result.api,b.api);strcpy(g_result.generation,b.generation);
 strcpy(g_result.ack,ack);strncpy(g_result.error,error,sizeof(g_result.error)-1);
 if(strcmp(ack,"pending"))for(unsigned i=0;i<b.count;++i)AddKey(!strcmp(ack,"config_request_accepted")?g_result.accepted:g_result.failed,1024,fields[b.ops[i].field].key);
 if(!strcmp(ack,"config_request_accepted"))g_result.acceptedCount=b.count;
}
static void WriteFlag(size_t offset) { *(BYTE*)(g_coreBase+kStateRva+offset)=1; }
static bool Readback(const Batch& b,const Snapshot& s,const Plan& plan) {
 bool needBackend=false,needFg=false,needSc=false,needClear=false;
 for(unsigned i=0;i<b.count;++i) {
  const auto& op=b.ops[i];size_t off=fields[op.field].offset;
  if(op.kind==BOOL){bool v;if(!ReadOption(s.config,off,&v)||v!=(op.integer!=0))return false;
   if(op.field==0&&op.integer)needFg=true;
   if(op.field==1){needFg=true;needClear=true;}
   if(op.field==2&&EffectiveFg(b,s))needFg=true;
  }
  else if(op.kind==I32){int32_t v;if(!ReadOption(s.config,off,&v)||v!=op.integer)return false;needFg=true;}
  else if(op.kind==FG_INDEX){int32_t v;if(!ReadOption(s.config,off,&v)||v!=op.integer)return false;needFg=true;needSc=true;}
  else if(op.kind==FFX_INDEX){int32_t v;if(!ReadOption(s.config,off,&v)||v!=op.integer)return false;needBackend=true;}
  else if(op.kind==F32){float v;if(!ReadOption(s.config,off,&v)||v!=op.real)return false;}
  else if(op.kind==BACKEND)needBackend=true;
 }
 if(plan.reloadSharpness)needBackend=true;
 if(plan.resetReactiveMask&&(!OptionalIsReset<bool>(s.config,offsetof(Config,DisableReactiveMask))||
                             !OptionalIsReset<float>(s.config,offsetof(Config,DlssReactiveMaskBias))))return false;
 if(needFg){bool value=false;if(!Flag(state_offsets_FGchanged,&value)||!value)return false;}
 if(needSc){bool value=false;if(!Flag(state_offsets_SCchanged,&value)||!value)return false;}
 if(needClear){bool value=false;if(!Flag(state_offsets_ClearCapturedHudlesses,&value)||!value)return false;}
 if(needBackend) {
  char desired[16];strcpy(desired,s.actualBackend);
  for(unsigned i=0;i<b.count;++i)if(b.ops[i].kind==BACKEND)strcpy(desired,b.ops[i].text);
  char pending[16];
  if(!ReadString((msvc_string*)(g_coreBase+kStateRva+state_offsets_newBackend),pending,sizeof(pending))||strcmp(pending,desired))return false;
  DenseTable table;BackendEntry* entries;unsigned count;
  if(!Backends(&table,&entries,&count)||!count)return false;
  for(unsigned i=0;i<count;++i)if(!entries[i].changed)return false;
 }
 return true;
}
static bool Apply(const Batch& b,const Snapshot& s) {
 const char* error;Plan plan;if(!Preflight(b,s,&error,&plan)){Finish(b,"rejected",error);return false;}
 // This runs on RenderMenu's caller thread. Values, flags, and the existing
 // newBackend string are written in place; no post-commit GPU work is awaited.
 bool backend=plan.reloadSharpness,fg=false,sc=false,clear=false;const char* code=s.actualBackend;
 auto* cfg=(Config*)s.config;
 for(unsigned i=0;i<b.count;++i) {
  const auto& op=b.ops[i];BYTE* dest=(BYTE*)s.config+fields[op.field].offset;
  if(op.kind==BOOL) {
   ((CustomOptional<bool>*)dest)->assign(op.integer!=0);
   if(op.field==0&&op.integer)fg=true;
   if(op.field==1){fg=true;clear=true;}
   if(op.field==2&&EffectiveFg(b,s))fg=true;
  } else if(op.kind==I32) {((CustomOptional<int32_t>*)dest)->assign(op.integer);fg=true;}
  else if(op.kind==F32)((CustomOptional<float>*)dest)->assign(op.real);
  else if(op.kind==BACKEND){code=op.text;backend=true;}
  else if(op.kind==FG_INDEX){cfg->FfxFGIndex.assign(op.integer);fg=true;sc=true;}
  else if(op.kind==FFX_INDEX){cfg->FfxUpscalerIndex.assign(op.integer);backend=true;}
 }
 if(plan.resetReactiveMask) {
  cfg->DisableReactiveMask.reset();
  cfg->DlssReactiveMaskBias.reset();
 }
 if(backend) {
  auto* pending=(msvc_string*)(g_coreBase+kStateRva+state_offsets_newBackend);
  pending->assign_in_place(code,strlen(code));
 }
 if(clear)WriteFlag(state_offsets_ClearCapturedHudlesses);
 if(fg)WriteFlag(state_offsets_FGchanged);
 if(sc)WriteFlag(state_offsets_SCchanged);
 if(backend)for(unsigned i=0;i<plan.count;++i)plan.entries[i].changed=1;
 if(Readback(b,s,plan)){Finish(b,"config_request_accepted","");return true;}
 Finish(b,"rejected","readback_mismatch");return false;
}
static void SampleTelemetry(Snapshot* s,ULONGLONG now) {
 double rawRendered=s->renderedMs,rawPresented=s->presentedMs;
 bool reset=!s->valid||!s->feature||!s->featureInited||s->featureFrozen||s->feature!=g_telemetryFeature||s->featureFrames<g_telemetryFeatureFrames||(g_telemetryTick&&now-g_telemetryTick>limits_frame_stale_ms);
 if(reset) {g_telemetryFeature=s->feature;g_telemetryFeatureFrames=s->featureFrames;g_telemetryStateFrames=s->frames;g_telemetryTick=now;g_featureProgressTick=g_presentProgressTick=0;g_presentCounterFps=0;g_lastRenderedInterval=rawRendered;g_lastPresentedInterval=rawPresented;g_renderedIntervalTick=g_presentedIntervalTick=0;}
 else {
  if(s->featureFrames>g_telemetryFeatureFrames)g_featureProgressTick=now;
  if(rawRendered>0&&rawRendered!=g_lastRenderedInterval)g_renderedIntervalTick=now;
  if(rawPresented>0&&rawPresented!=g_lastPresentedInterval)g_presentedIntervalTick=now;
  g_lastRenderedInterval=rawRendered;g_lastPresentedInterval=rawPresented;
  ULONGLONG elapsed=now-g_telemetryTick;
  if(s->frames>g_telemetryStateFrames&&elapsed) {double fps=(double)(s->frames-g_telemetryStateFrames)*1000.0/(double)elapsed;
   if(fps>0&&fps<=2000){g_presentCounterFps=fps;g_presentProgressTick=now;}else {g_presentCounterFps=0;g_presentProgressTick=0;}}
  else if(s->frames<g_telemetryStateFrames){g_presentCounterFps=0;g_presentProgressTick=0;}
  g_telemetryFeatureFrames=s->featureFrames;g_telemetryStateFrames=s->frames;g_telemetryTick=now;
 }
 s->featureProgressTick=g_featureProgressTick;s->telemetryReady=g_featureProgressTick&&now-g_featureProgressTick<=limits_frame_stale_ms;
 s->presentCounterFps=s->telemetryReady&&g_presentProgressTick&&now-g_presentProgressTick<=limits_frame_stale_ms?g_presentCounterFps:0;
 bool renderFresh=s->presentCounterFps>0||(g_renderedIntervalTick&&now-g_renderedIntervalTick<=limits_frame_stale_ms);
 bool presentFresh=s->presentCounterFps>0||(g_presentedIntervalTick&&now-g_presentedIntervalTick<=limits_frame_stale_ms);
 s->renderedMs=s->telemetryReady&&renderFresh?rawRendered:0;s->presentedMs=s->telemetryReady&&presentFresh?rawPresented:0;
}
static bool RenderMenuHook() {
 bool owns=InterlockedCompareExchange(&g_inCallback,1,0)==0;
 if(owns&&InterlockedCompareExchange(&g_callbackAuthorized,0,0)&&TryAcquireSRWLockExclusive(&g_lock)) {
  BYTE inited=0;
  if(ReadDataRva(rva_menu_inited,&inited,1)&&inited==1) {
   Snapshot now;
   if(Capture(&now)) {
    g_lastFrame=GetTickCount64();
    if(g_hasQueued) {
     Batch b=g_queued;g_hasQueued=false;Apply(b,now);
     Snapshot updated;if(Capture(&updated))now=updated;
    }
    SampleTelemetry(&now,GetTickCount64());g_snapshot=now;
   } else {g_snapshot.valid=false;g_snapshot.frameReady=false;}
  }
  ReleaseSRWLockExclusive(&g_lock);
 }
 bool result=g_renderMenu?g_renderMenu():false;
 if(owns)InterlockedExchange(&g_inCallback,0);
 return result;
}
using Transaction = LONG (WINAPI*)();
using Attach = LONG (WINAPI*)(PVOID*,PVOID);
using UpdateThread = LONG (WINAPI*)(HANDLE);
static bool CodeMatches(DWORD rva,const BYTE* prologue,size_t length) {
 if(!RvaFits(rva,length,g_coreImageSize)||!CheckMemory(g_coreBase+rva,length,false))return false;
 MEMORY_BASIC_INFORMATION region;if(!VirtualQuery(g_coreBase+rva,&region,sizeof(region)))return false;
 if(region.AllocationBase!=g_core||!(region.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY)))return false;
 return BytesEqual(g_coreBase+rva,prologue,length);
}
static bool BootstrapCallerMatches(uintptr_t returnAddress) {
 if(!g_coreValid||returnAddress<(uintptr_t)g_coreBase||
    returnAddress-(uintptr_t)g_coreBase!=bootstrap_return_rva||bootstrap_return_rva<sizeof(bootstrap_call_before_return))return false;
 return CodeMatches(bootstrap_return_rva-sizeof(bootstrap_call_before_return),
                    bootstrap_call_before_return,sizeof(bootstrap_call_before_return))&&
        CodeMatches(bootstrap_return_rva,bootstrap_return_prologue,sizeof(bootstrap_return_prologue));
}
static bool MenuNotInitialized() {
 BYTE inited=1;
 return ReadDataRva(rva_menu_inited,&inited,1)&&inited==0;
}
static bool InstallHook() {
#define VERIFY_HOOK(N) if(!CodeMatches(hook_##N##_rva,hook_##N##_prologue,sizeof(hook_##N##_prologue)))return false
 VERIFY_HOOK(render_menu);VERIFY_HOOK(detour_begin);VERIFY_HOOK(detour_abort);VERIFY_HOOK(detour_commit);VERIFY_HOOK(detour_attach);VERIFY_HOOK(detour_update_thread);
#undef VERIFY_HOOK
 auto begin=(Transaction)(g_coreBase+hook_detour_begin_rva),abort=(Transaction)(g_coreBase+hook_detour_abort_rva),commit=(Transaction)(g_coreBase+hook_detour_commit_rva);
 auto attach=(Attach)(g_coreBase+hook_detour_attach_rva);auto update=(UpdateThread)(g_coreBase+hook_detour_update_thread_rva);
 if(!MenuNotInitialized())return false;
 if(begin()!=NO_ERROR)return false;
 g_renderMenu=(bool(*)())(g_coreBase+hook_render_menu_rva);
 bool ok=update(GetCurrentThread())==NO_ERROR;
 if(ok)ok=attach((PVOID*)&g_renderMenu,(PVOID)&RenderMenuHook)==NO_ERROR;
 if(ok)ok=commit()==NO_ERROR;
 if(!ok){abort();return false;}
 g_hookInstalled=true;return true;
}
static bool JoinPath(wchar_t* out,const wchar_t* leaf) {
 size_t n=wcslen(g_parentDirectory),m=wcslen(leaf);if(n+m+2>=MAX_PATH)return false;
 memcpy(out,g_parentDirectory,n*sizeof(wchar_t));if(n&&out[n-1]!=L'\\')out[n++]=L'\\';memcpy(out+n,leaf,(m+1)*sizeof(wchar_t));return true;
}
static bool SetupPaths() {
 DWORD n=GetModuleFileNameW(g_self,g_parentDirectory,MAX_PATH);if(!n||n>=MAX_PATH)return false;
 wchar_t* slash=wcsrchr(g_parentDirectory,L'\\');if(!slash)return false;*slash=0;
 slash=wcsrchr(g_parentDirectory,L'\\');if(slash&&!_wcsicmp(slash+1,L"plugins"))*slash=0;
 if(!JoinPath(g_commandPath,L"decky_optiscaler_live.cmd")||!JoinPath(g_statusPath,L"decky_optiscaler_live.status")||!JoinPath(g_logPath,L"decky_optiscaler_live.log"))return false;
 char utf8[MAX_PATH*4];if(!Utf8(g_parentDirectory,utf8,sizeof(utf8))){g_startError="invalid_control_path_utf16";return false;}return true;
}
static void Log(const char* value) {
 if(!g_controlOwned)return;
 HANDLE h=CreateFileW(g_logPath,FILE_APPEND_DATA,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);if(h==INVALID_HANDLE_VALUE)return;
 DWORD n;WriteFile(h,value,(DWORD)strlen(value),&n,NULL);WriteFile(h,"\n",1,&n,NULL);CloseHandle(h);
}
struct StatusBuffer {
 char body[16384];size_t used=0;bool ok=true;
 void put(const char* value){if(!ok)return;size_t n=strlen(value);if(n>=sizeof(body)-used){ok=false;return;}memcpy(body+used,value,n);used+=n;body[used]=0;}
 template<class... A> void put(const char* fmt,A...args){if(!ok)return;int n=snprintf(body+used,sizeof(body)-used,fmt,args...);if(n<0||(size_t)n>=sizeof(body)-used){ok=false;return;}used+=(size_t)n;}
};
static void StatusVersions(StatusBuffer* b,const char* key,const Versions& v,bool ids) {
 b->put("%s ",key);for(unsigned i=0;i<v.count;++i){if(i)b->put("|");if(ids)b->put("%llu",(unsigned long long)v.ids[i]);else b->put("%s",v.names[i]);}b->put("\n");
}
static void WriteStatus() {
 if(!g_controlOwned)return;
 Snapshot s;Result r;bool occupied,dirVerified;uint64_t directoryGeneration;ULONGLONG frame;
 AcquireSRWLockShared(&g_lock);s=g_snapshot;r=g_result;occupied=g_hasQueued;frame=g_lastFrame;dirVerified=g_directoryAuth.verified;directoryGeneration=g_directoryAuth.generation;ReleaseSRWLockShared(&g_lock);
 bool frameReady=g_hookInstalled&&s.valid&&s.dirVerified&&dirVerified&&s.directoryGeneration==directoryGeneration&&frame&&GetTickCount64()-frame<=limits_frame_stale_ms;
 const char* status=*g_startError?"failed":!g_coreValid?"searching":!dirVerified?"awaiting_config":!frameReady?"awaiting_frame":"ready";
 char dir[MAX_PATH*4]={};if(!Utf8(g_parentDirectory,dir,sizeof(dir))){frameReady=false;status="failed";}
 bool telemetry=frameReady&&s.telemetryReady&&s.featureProgressTick&&GetTickCount64()-s.featureProgressTick<=limits_frame_stale_ms;
 StatusBuffer b;
 b.put("schema 7\nstatus %s\nsession %s\nseq %llu\nack %s\naccepted_count %u\n",status,g_session,(unsigned long long)r.seq,r.ack[0]?r.ack:"none",r.acceptedCount);
 b.put("request_session %s\nrequest_api %s\nrequest_generation %s\n",r.session,r.api,r.generation);
 char prefix[MAX_PATH*16]={};Utf8(g_winePrefix,prefix,sizeof(prefix));b.put("dir_verified %u\ndirectory_generation %llu\nresult_directory_generation %llu\nwine_prefix %s\n",dirVerified?1:0,(unsigned long long)directoryGeneration,(unsigned long long)r.directoryGeneration,prefix);
 b.put("asi_build %s\nabi_profile %s\ncore_sha256 %s\ncore_valid %u\nframe_ready %u\nactive_api %s\ncapability_generation %s\n",build_id,profile_id,g_coreValid?core_sha256:"",g_coreValid?1:0,frameReady?1:0,ApiName(s.api),s.generation[0]?s.generation:"none");
 b.put("can_set_scalar %u\ncan_switch_upscaler %u\ncan_override_sharpness %u\nswitchable_backends %s\ncan_change_fg %u\ncan_enable_fg %u\ncan_change_fg_version %u\ncan_change_ffx_upscaler %u\ncan_change_xefg_count %u\ncan_change_opti_fg %u\ncan_change_hud_fix %u\ncan_change_fsr_debug_view %u\ncan_reset_auto 0\ncommand_pending %u\n",frameReady&&s.scalar,frameReady&&s.switchableBackends[0],frameReady&&s.canOverrideSharpness,frameReady?s.switchableBackends:"",frameReady&&s.fg,frameReady&&s.fgCanEnable,frameReady&&s.fgVersion,frameReady&&s.ffx,frameReady&&s.xefgCount,frameReady&&s.optiFg,frameReady&&s.hudFix,frameReady&&s.fsrDebug,occupied?1:0);
 b.put("accepted_keys %s\nfailed_keys %s\nconfig %p\nstate %p\nbackends %p\nnewbackend %p\nframecount %p\n",r.accepted,r.failed,(void*)s.config,g_coreValid?(void*)(g_coreBase+kStateRva):NULL,g_coreValid?(void*)(g_coreBase+kStateRva+state_offsets_changeBackend):NULL,g_coreValid?(void*)(g_coreBase+kStateRva+state_offsets_newBackend):NULL,g_coreValid?(void*)(g_coreBase+kStateRva+state_offsets_frameCount):NULL);
 b.put("backend_entries %u\nframes %llu\ndir %s\nfps %.1f\nfg_enabled %d\ndx12_upscaler %s\ndx11_upscaler %s\nvulkan_upscaler %s\npending_backend %s\n",s.backendEntries,(unsigned long long)s.frames,dir,telemetry?s.presentCounterFps:0.0,(s.valid&&s.fgObjectKind)?(s.fgActive?1:0):(s.valid&&!s.currentFg&&s.activeFgOutput==0)?0:-1,s.api==2&&s.featureInited?s.actualBackend:"",s.api==1&&s.featureInited?s.actualBackend:"",s.api==3&&s.featureInited?s.actualBackend:"",s.pending);
 b.put("fgflags %p\nfg_index -1\nffx_upscaler_index -1\n",g_coreValid?(void*)(g_coreBase+kStateRva+state_offsets_FGchanged):NULL);
 b.put("configured_fg_enabled %d\nconfigured_fg_index %d\nconfigured_ffx_upscaler_index %d\nconfigured_dx12_upscaler %s\nconfigured_dx11_upscaler %s\nconfigured_vulkan_upscaler %s\n",s.valid?s.fgEnabled:-1,s.valid?s.fgIndex:-1,s.valid?s.ffxIndex:-1,s.dx12,s.dx11,s.vk);
 StatusVersions(&b,"ffx_fg_versions",s.fgVersions,false);StatusVersions(&b,"ffx_fg_ids",s.fgVersions,true);StatusVersions(&b,"ffx_upscaler_versions",s.upVersions,false);StatusVersions(&b,"ffx_upscaler_ids",s.upVersions,true);
 b.put("rendered_ms %.3f\npresented_ms %.3f\nfeature_frames %u\nerror %s\n",telemetry?s.renderedMs:0.0,telemetry?s.presentedMs:0.0,s.featureFrames,r.error[0]?r.error:g_startError);
 b.put("telemetry_ready %u\ntelemetry_source %s\nfeature_progress_age_ms %llu\n",telemetry?1:0,!telemetry?"unknown":s.presentCounterFps>0?"state_present_counter":(s.renderedMs>0||s.presentedMs>0)?"core_intervals":"unknown",(unsigned long long)(s.featureProgressTick?GetTickCount64()-s.featureProgressTick:UINT64_MAX));
 if(!b.ok)return;
 wchar_t tmp[MAX_PATH];if(!JoinPath(tmp,L"decky_optiscaler_live.status.tmp"))return;
 DeleteFileW(tmp); // Remove only the old temporary name; never truncate an existing inode.
 HANDLE h=CreateFileW(tmp,GENERIC_WRITE,FILE_SHARE_READ,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);if(h==INVALID_HANDLE_VALUE)return;
 DWORD written=0;bool success=WriteFile(h,b.body,(DWORD)b.used,&written,NULL)&&written==b.used;CloseHandle(h);
 if(success)MoveFileExW(tmp,g_statusPath,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);else DeleteFileW(tmp);
}
static void ReceiveCommand(const char* input,size_t n) {
 if(g_hasQueued)return;
 Batch batch;const char* error;
 if(!ParseBatch(input,n,&batch,&error)) {
  if(batch.seq>g_lastSequence&&!strcmp(batch.session,g_session)) {g_lastSequence=batch.seq;Finish(batch,"rejected",error);}
  return;
 }
 if(strcmp(batch.session,g_session)||batch.seq<=g_lastSequence)return;
 g_lastSequence=batch.seq;
 if(!g_controlOwned||!g_directoryAuth.verified){Finish(batch,"rejected","directory_authorization_changed");return;}
 // The wire carries the sender's capability token. Never relabel a late G1
 // scalar as G2 just because it first reaches this mailbox after reauth.
 if(!g_snapshot.valid||!g_snapshot.dirVerified||g_snapshot.directoryGeneration!=g_directoryAuth.generation||!ContextMatches(batch,g_snapshot)) {Finish(batch,"rejected","selection_context_changed");return;}
 batch.directoryGeneration=g_directoryAuth.generation;
 if(!g_hookInstalled||!g_snapshot.valid||!g_lastFrame||GetTickCount64()-g_lastFrame>limits_frame_stale_ms)Finish(batch,"rejected","awaiting_frame");
 else {g_queued=batch;g_hasQueued=true;g_queuedSince=GetTickCount64();Finish(batch,"pending","");}
}
static void PollCommand() {
 if(!g_controlOwned)return;
 static char previous[limits_command_bytes+1];static size_t previousSize=0;
 HANDLE h=CreateFileW(g_commandPath,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);if(h==INVALID_HANDLE_VALUE)return;
 LARGE_INTEGER size;char input[limits_command_bytes+1];DWORD n=0;
 bool ok=GetFileSizeEx(h,&size)&&size.QuadPart>0&&size.QuadPart<=limits_command_bytes&&ReadFile(h,input,(DWORD)size.QuadPart,&n,NULL)&&n==(DWORD)size.QuadPart;CloseHandle(h);if(!ok)return;
 if(previousSize==n&&!memcmp(previous,input,n))return;
 AcquireSRWLockExclusive(&g_lock);
 // The mailbox remains occupied only while the request waits for RenderMenu.
 if(g_hasQueued){ReleaseSRWLockExclusive(&g_lock);return;}
 memcpy(previous,input,n);previousSize=n;
 ReceiveCommand(input,n);
 ReleaseSRWLockExclusive(&g_lock);
}
static void ExpireCommands(ULONGLONG now) {
 if(g_hasQueued&&now-g_queuedSince>=limits_callback_timeout_ms){Finish(g_queued,"rejected","callback_timeout");g_hasQueued=false;}
}
static DWORD WINAPI Worker(void*) {
 // InitializeASI installs the passthrough hook synchronously. This worker
 // authenticates the disk image and physical directory before enabling it.
 if(!g_self||!g_core||!g_coreValid)return 0;
 if(!SetupPaths())return 0;
 wchar_t executable[MAX_PATH];DWORD exeLen=GetModuleFileNameW(NULL,executable,MAX_PATH);
 const wchar_t* name=exeLen&&exeLen<MAX_PATH?wcsrchr(executable,L'\\'):NULL;
 if(!exeLen||exeLen>=MAX_PATH||!Utf8(name?name+1:executable,g_exeName,sizeof(g_exeName))){g_startError="invalid_executable_path_utf16";return 0;}
 FILETIME ft;LARGE_INTEGER qpc;GetSystemTimeAsFileTime(&ft);QueryPerformanceCounter(&qpc);
 ULARGE_INTEGER stamp;stamp.LowPart=ft.dwLowDateTime;stamp.HighPart=ft.dwHighDateTime;
 snprintf(g_session,sizeof(g_session),"%lu-%016llx-%016llx",(unsigned long)GetCurrentProcessId(),(unsigned long long)stamp.QuadPart,(unsigned long long)qpc.QuadPart);

 wchar_t corePath[MAX_PATH];
 DWORD coreLength=GetModuleFileNameW(g_core,corePath,MAX_PATH);
 if(!coreLength||coreLength>=MAX_PATH){g_startError="core_path_invalid";return 0;}
 if(!OwnControlDirectory(corePath)){g_startError="wrong_control_directory";return 0;}
 ReadWinePrefix();
 if(!HashMatchesPinnedCore(corePath)){g_startError="core_hash_mismatch";WriteStatus();return 0;}
 g_coreHashValid=true;
 RefreshDirectoryAuth();WriteStatus();Log("decky live schema7: verified core and control directory");
 Log("verified core, RenderMenu passthrough is ready");
 for(;;) {
  RefreshDirectoryAuth();
  PollCommand();
  AcquireSRWLockExclusive(&g_lock);
  ExpireCommands(GetTickCount64());
  ReleaseSRWLockExclusive(&g_lock);
  WriteStatus();Sleep(200);
 }
}
#ifdef DECKY_LIVE_TEST
static bool (*g_testPinSelf)(HMODULE*);
static HANDLE (*g_testCreateWorker)();
#endif
static bool PinSelf(HMODULE* owned) {
#ifdef DECKY_LIVE_TEST
 if(g_testPinSelf)return g_testPinSelf(owned);
#endif
 return GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,(LPCWSTR)&g_started,owned)!=FALSE;
}
static HANDLE CreateWorker() {
#ifdef DECKY_LIVE_TEST
 if(g_testCreateWorker)return g_testCreateWorker();
#endif
 return CreateThread(NULL,0,Worker,NULL,0,NULL);
}
static void StartWorkerOnce(uintptr_t returnAddress) {
 if(InterlockedCompareExchange(&g_started,1,0))return;
 // OptiScaler calls InitializeASI synchronously from LoadAsiPlugins. Refuse
 // calls from any other site and install only the one RenderMenu detour here,
 // while the menu is still uninitialized and this caller thread is current.
 HMODULE core=NULL;
 if(!returnAddress||!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
       reinterpret_cast<LPCWSTR>(returnAddress),&core)){g_startError="initialize_caller_unavailable";InterlockedExchange(&g_started,0);return;}
 if(!ValidateCoreImage(core)){g_startError="unknown_core";FreeLibrary(core);InterlockedExchange(&g_started,0);return;}
 if(!BootstrapCallerMatches(returnAddress)){g_startError="unknown_initialize_caller";g_core=NULL;g_coreBase=NULL;g_coreImageSize=0;g_coreValid=false;FreeLibrary(core);InterlockedExchange(&g_started,0);return;}
 HMODULE owned=NULL;
 if(!PinSelf(&owned)){g_startError="asi_pin_failed";g_core=NULL;g_coreBase=NULL;g_coreImageSize=0;g_coreValid=false;FreeLibrary(core);InterlockedExchange(&g_started,0);return;}
 g_self=owned;
 if(!InstallHook()) {g_startError="hook_install_failed";g_core=NULL;g_coreBase=NULL;g_coreImageSize=0;g_coreValid=false;FreeLibrary(core);InterlockedExchange(&g_started,0);return;}
 HANDLE thread=CreateWorker();if(thread)CloseHandle(thread);else g_startError="worker_start_failed";
}
} // namespace live
#ifndef DECKY_LIVE_TEST
extern "C" __declspec(dllexport) __attribute__((noinline)) void InitializeASI() {
 live::StartWorkerOnce((uintptr_t)__builtin_return_address(0));
}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID) {
 if(reason==DLL_PROCESS_ATTACH){live::g_self=instance;DisableThreadLibraryCalls(instance);}
 return TRUE;
}
#endif
