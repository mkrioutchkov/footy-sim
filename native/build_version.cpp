#include "build_version.h"

#define STRINGIFY_IMPL(x) #x
#define STRINGIFY(x) STRINGIFY_IMPL(x)

#ifndef BUILD_GIT_HASH
#define BUILD_GIT_HASH unknown
#endif

#ifndef BUILD_GIT_CUSTOM
#define BUILD_GIT_CUSTOM 0
#endif

#if BUILD_GIT_CUSTOM
#define BUILD_GIT_SUFFIX " custom"
#else
#define BUILD_GIT_SUFFIX ""
#endif

const char* nativeBuildVersion() {
    return STRINGIFY(BUILD_GIT_HASH) BUILD_GIT_SUFFIX;
}
