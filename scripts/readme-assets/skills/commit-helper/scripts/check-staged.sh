#!/bin/sh
# 列出暂存区与未暂存的改动，提交前过一眼。
git status --short
echo "--- staged ---"
git diff --cached --stat
