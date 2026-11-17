// Directory ownership is proved on Worker with actual Win32 directory handles.
// The menu callback only compares pointer/path bytes against this publication.
struct DirectoryAuth { bool verified;uint64_t generation;uintptr_t config;wchar_t path[512]; };
static DirectoryAuth g_directoryAuth;
static uint64_t g_directoryGeneration;
static bool g_controlOwned;
static HANDLE g_targetDirectoryHandle=INVALID_HANDLE_VALUE,g_coreDirectoryHandle=INVALID_HANDLE_VALUE,g_configDirectoryHandle=INVALID_HANDLE_VALUE;
static wchar_t g_canonicalDirectory[MAX_PATH],g_winePrefix[MAX_PATH*4];
#ifdef DECKY_LIVE_TEST
static bool (*g_testDirectoryAuthMatches)(uintptr_t);
#endif
static void Finish(const Batch&,const char*,const char*);
static bool DirectoryIdentity(HANDLE handle,FILE_ID_INFO* id) {
 BY_HANDLE_FILE_INFORMATION basic;
 return handle!=INVALID_HANDLE_VALUE&&GetFileInformationByHandle(handle,&basic)&&
  (basic.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)&&GetFileInformationByHandleEx(handle,FileIdInfo,id,sizeof(*id));
}
static HANDLE OpenDirectory(const wchar_t* path) {
 return CreateFileW(path,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
}
static bool SameDirectory(HANDLE a,HANDLE b) {
 FILE_ID_INFO x,y;return DirectoryIdentity(a,&x)&&DirectoryIdentity(b,&y)&&x.VolumeSerialNumber==y.VolumeSerialNumber&&BytesEqual(x.FileId.Identifier,y.FileId.Identifier,16);
}
static bool ParentDirectory(const wchar_t* path,wchar_t* out,size_t capacity) {
 size_t length=wcslen(path);if(!length||length>=capacity)return false;
 memcpy(out,path,(length+1)*sizeof(wchar_t));wchar_t* back=wcsrchr(out,L'\\'),*forward=wcsrchr(out,L'/');wchar_t* slash=back;
 if(!slash||(forward&&forward>slash))slash=forward;if(!slash)return false;
 if(slash>out&&slash[-1]==L':')slash[1]=0;else *slash=0;return out[0]!=0;
}
static bool SafeConfigPath(uintptr_t* config,wchar_t path[512]) {
 uintptr_t first=0,last=0;wchar_t again[512];
 if(!ReadConfigPointer(&first)||!first||!ReadWStringAt(first,offsetof(Config,absoluteFileName),path,512)||
    !IsAbsoluteWindowsPath(path)||!ReadWStringAt(first,offsetof(Config,absoluteFileName),again,512)||
    wcscmp(path,again)||!ReadConfigPointer(&last)||first!=last)return false;
 *config=first;return true;
}
static void RevokeDirectoryBatches() {
 if(g_result.seq&&g_result.directoryGeneration!=g_directoryAuth.generation){strcpy(g_result.ack,"rejected");strcpy(g_result.error,"directory_authorization_changed");g_result.acceptedCount=0;strncpy(g_result.failed,g_result.accepted,sizeof(g_result.failed)-1);g_result.accepted[0]=0;}
 if(g_hasQueued&&g_queued.directoryGeneration!=g_directoryAuth.generation){Finish(g_queued,"rejected","directory_authorization_changed");g_hasQueued=false;}
}
static void RevokeDirectoryAuth() {
 InterlockedExchange(&g_callbackAuthorized,0);
 if(g_directoryAuth.verified){g_directoryAuth.verified=false;g_directoryAuth.generation=++g_directoryGeneration;}
 RevokeDirectoryBatches();
}
static bool DirectoryAuthMatches(uintptr_t config) {
#ifdef DECKY_LIVE_TEST
 if(g_testDirectoryAuthMatches)return g_testDirectoryAuthMatches(config);
#endif
 wchar_t path[512];uintptr_t current=0;
 if(!g_controlOwned||!g_directoryAuth.verified||!SafeConfigPath(&current,path)||current!=config||
    current!=g_directoryAuth.config||wcscmp(path,g_directoryAuth.path)){RevokeDirectoryAuth();return false;}
 return true;
}
static bool OwnControlDirectory(const wchar_t* corePath) {
 wchar_t parent[MAX_PATH];if(!ParentDirectory(corePath,parent,MAX_PATH))return false;
 HANDLE target=OpenDirectory(g_parentDirectory),core=OpenDirectory(parent);
 bool same=SameDirectory(target,core);DWORD length=0;
 if(same)length=GetFinalPathNameByHandleW(target,g_canonicalDirectory,MAX_PATH,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
 if(!same||!length||length>=MAX_PATH){if(target!=INVALID_HANDLE_VALUE)CloseHandle(target);if(core!=INVALID_HANDLE_VALUE)CloseHandle(core);g_canonicalDirectory[0]=0;return false;}
 // Future control-file operations use the handle's canonical target path,
 // never a potentially retargeted short path/junction supplied by the loader.
 wcscpy(g_parentDirectory,g_canonicalDirectory);
 if(!JoinPath(g_commandPath,L"decky_optiscaler_live.cmd")||!JoinPath(g_statusPath,L"decky_optiscaler_live.status")||!JoinPath(g_logPath,L"decky_optiscaler_live.log")) {CloseHandle(target);CloseHandle(core);return false;}
 g_targetDirectoryHandle=target;g_coreDirectoryHandle=core;g_controlOwned=true;return true;
}
static void RefreshDirectoryAuth() {
 if(!g_controlOwned)return;
 uintptr_t config=0,confirm=0;wchar_t path[512],again[512],parent[512];HANDLE candidate=INVALID_HANDLE_VALUE;
 bool valid=g_coreHashValid&&SafeConfigPath(&config,path)&&ParentDirectory(path,parent,512);
 if(valid){candidate=OpenDirectory(parent);valid=SameDirectory(candidate,g_targetDirectoryHandle)&&SameDirectory(g_coreDirectoryHandle,g_targetDirectoryHandle)&&SafeConfigPath(&confirm,again)&&confirm==config&&!wcscmp(path,again);}
 AcquireSRWLockExclusive(&g_lock);
 if(valid) {
  bool changed=!g_directoryAuth.verified||g_directoryAuth.config!=config||wcscmp(g_directoryAuth.path,path);
  if(changed){g_directoryAuth.verified=true;g_directoryAuth.config=config;wcscpy(g_directoryAuth.path,path);g_directoryAuth.generation=++g_directoryGeneration;RevokeDirectoryBatches();}
 } else RevokeDirectoryAuth();
 HANDLE old=g_configDirectoryHandle;g_configDirectoryHandle=valid?candidate:INVALID_HANDLE_VALUE;
 ReleaseSRWLockExclusive(&g_lock);
 InterlockedExchange(&g_callbackAuthorized,valid?1:0);
 if(old!=INVALID_HANDLE_VALUE)CloseHandle(old);if(!valid&&candidate!=INVALID_HANDLE_VALUE)CloseHandle(candidate);
}
static bool PrefixWireSafe(){for(const wchar_t* p=g_winePrefix;*p;++p)if(*p<32||*p==127)return false;return true;}
static void ReadWinePrefix() {
 g_winePrefix[0]=0;DWORD n=GetEnvironmentVariableW(L"WINEPREFIX",g_winePrefix,MAX_PATH*4);
 if(n){if(n>=MAX_PATH*4||!PrefixWireSafe())g_winePrefix[0]=0;return;}
 n=GetEnvironmentVariableW(L"STEAM_COMPAT_DATA_PATH",g_winePrefix,MAX_PATH*4);
 if(!n||n>=MAX_PATH*4){g_winePrefix[0]=0;return;}
 while(n&&(g_winePrefix[n-1]==L'/'||g_winePrefix[n-1]==L'\\'))g_winePrefix[--n]=0;
 if(n+5>=MAX_PATH*4){g_winePrefix[0]=0;return;}wcscat(g_winePrefix,L"/pfx");if(!PrefixWireSafe())g_winePrefix[0]=0;
}
