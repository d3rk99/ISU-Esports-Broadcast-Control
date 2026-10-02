# isu-capture: OBS's libdshowcapture (LGPL-2.1, built as its own DLL, unmodified) + a small
# capture program that streams raw A/V with capture timestamps to FFmpeg. Windows + MSVC only.
#   cmake -S . -B build -A x64 && cmake --build build --config Release
cmake_minimum_required(VERSION 3.28)
project(isu-capture CXX)
if(NOT MSVC)
  message(FATAL_ERROR "isu-capture builds on Windows with Visual Studio (MSVC).")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED TRUE)

include(FetchContent)
# Pinned to the exact upstream commit reviewed for this integration.
FetchContent_Declare(libdshowcapture
  GIT_REPOSITORY https://github.com/obsproject/libdshowcapture.git
  GIT_TAG c13d4b7b0c66979396ba0a9060c9aafc15bb7b22
  GIT_SUBMODULES_RECURSE TRUE)
set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(libdshowcapture)

add_executable(isu-capture src/main.cpp src/mkv_writer.hpp)
target_include_directories(isu-capture PRIVATE ${libdshowcapture_SOURCE_DIR} src)
target_compile_definitions(isu-capture PRIVATE UNICODE _UNICODE NOMINMAX)
target_link_libraries(isu-capture PRIVATE libdshowcapture ole32 oleaut32 uuid)
# Keep the DLL next to the exe (LGPL: shipped as a separate, replaceable library).
add_custom_command(TARGET isu-capture POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different
  $<TARGET_FILE:libdshowcapture> $<TARGET_FILE_DIR:isu-capture>)
