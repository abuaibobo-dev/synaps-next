cmake_minimum_required(VERSION 3.22.1)
project("appmodules")

# Build libappmodules.so: React Native's core TurboModules, Fabric, codegen and
# autolinked C++ libraries (the standard RN 0.81 app template).
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# Embedded Node.js (nodejs-mobile) bridge, kept in its own target so the
# *.cpp glob above (used by ReactNative-application.cmake) stays clean.
add_library(native-lib SHARED native/native-lib.cpp)

include_directories(${CMAKE_SOURCE_DIR}/../../../libnode/include/node/)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode
        PROPERTIES IMPORTED_LOCATION
        ${CMAKE_SOURCE_DIR}/../../../libnode/bin/${ANDROID_ABI}/libnode.so)

target_link_libraries(native-lib
        libnode
        android
        log)
