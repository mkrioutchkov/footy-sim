#include "build_version.h"

const char* nativeBuildVersion() {
    return "cpp " __TIME__;
}
