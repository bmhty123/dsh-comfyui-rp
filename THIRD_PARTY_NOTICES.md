# 第三方声明

本插件的 ComfyUI 工作流节点识别部分在实现思路上参考了 **dsh-tavern-image**，主要包括：

- 从采样器的 `positive` / `negative` 连线反向查找真正写提示词的文本节点；
- 识别上游 `Text (Multiline)` / `String` 一类非 `CLIPTextEncode` 文本节点；
- 遇到 `ConditioningZeroOut` 时停止向上回溯，避免把清空后的负面误认成负面词；
- 从工作流 API JSON 中识别尺寸、单 LoRA 等可调参数。

本插件未复制该项目的界面、素材或世界书内容；节点识别相关实现按其 MIT 许可证保留以下声明。

- 项目：dsh-tavern-image
- 仓库：https://github.com/weixinlll/dsh-tavern-image
- 许可证：MIT

```text
MIT License

Copyright (c) 2026 dsh-tavern-image contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 推荐搭配（非捆绑）

本插件不包含、不修改、不调用 **anima-tagger**，仅在文档中推荐把它作为提示词来源会话：

- 项目：anima-tagger
- 作者：Vincent54122
- 仓库：https://github.com/Vincent54122/anima-tagger
- 许可证：MIT

如果你把 anima-tagger 与本插件一起分发，请同时保留它自己的 LICENSE 与 THIRD_PARTY_NOTICES。

