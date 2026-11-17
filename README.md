# ber-records

运营商交换记录中开放扩展的分层接收相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

接收 BER（X.690 子集）记录流：high-tag-number、short/long definite length、仅 constructed 可用的 indefinite length。一个顶层 TLV 是一条记录；来源把记录切在任意网络块上不影响拆分结果。收件结论三态分明：

- `complete`：流正常结束，每条记录给出字节跨度；
- `incomplete`：容器尚未闭合（不定长容器未遇 EOC、声明长度未收齐、头部截断），保留未闭合容器栈、待收字节数等依据；
- `corrupt`：长度/结构损坏（定长父容器装不下子项、primitive 用不定长、保留长度字、定长容器内或顶层出现 EOC 等），给出可证明的偏移与影响范围。

长度损坏或顶层未闭合时不继续猜下一条；EOC 只在不定长容器期待子项的位置解释，primitive 内容里的 `0000` 是数据，不扫描结束标记。

按 `/schema` 声明的记录类型领取结构化字段：tag 身份 = class + constructed + tag，同号 tag 不跨 class 或上下文套解释。未知扩展以原 TLV、嵌套路径及字节位置保存，未知构造内容按 BER 结构检查但不深入套解释。能证明边界的单条记录语义失败（如 INTEGER 内容为空）隔离到该条，不影响同批其他记录。

`src/reader.mjs` 是流式 BER 读取器（`BerStreamParser`/`parseStream`/`inspect`）；`src/schema.mjs` 负责 schema 校验、记录解释与流摘要；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要和解释结果。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取单件原件、按 schema 接收 `/stream` 两条记录（含开放扩展）、登记 `/damaged` 的未闭合依据，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按单件契约接收一件原件；内容不是恰好一条完整记录时不登记资料。
- POST /streams，JSON 为 {"path":"/stream","schema":"/schema"}：接收 BER 记录流；`schema` 可省略，省略时只按结构拆分记录不解释字段。已闭合记录、扩展、失败依据一并登记，同 source URL、同摘要重领返回原 id。
- GET /records：持久接收目录。
- GET /objects/{digest}：读取已保存的原始字节。

这五项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。/streams 的 201 表示交付已登记，内容结论看 `parsed.outcome`；/intakes 保持解释失败不登记。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖流式读取器（不定长容器、high-tag、任意分块、损坏偏移）、schema 解释、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t ber-records:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
