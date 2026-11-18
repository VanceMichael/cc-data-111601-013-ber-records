# ber-records

运营商交换记录中开放扩展的分层接收相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

可查看受支持的定长 BER 记录及原始字段跨度；连续交付接收支持 BER TLV 子集：class、constructed、tag 三者参与身份，high-tag-number、short/long definite length，以及仅用于 constructed 的 indefinite length。交付可按任意网络块切分，接收不依赖块边界。

`src/ber.mjs` 是流式接收器：EOC 只闭合当前不定长容器，不是字节扫描标记；接收结果区分正常结束（ok）、容器尚未闭合（unclosed）、长度损坏（length）与结构损坏（corrupt），损坏影响范围以字节区间登记，损坏后不扫描结束标记继续猜。`src/interpret.mjs` 按来源 /schema 声明领取结构化字段，未知扩展以原 TLV、嵌套路径与字节位置保存；已知路径只匹配 universal class 的同号 tag，不跨 class 或上下文套解释。`src/delivery.mjs` 串联领取与解释；`src/reader.mjs` 保留现有单件读取契约；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果与交付记录。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取单件资料、接收一段含开放扩展的连续交付与一段长度损坏交付，读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /deliveries，JSON 为 {"path":"/stream","schema":"/schema"|null}：流式接收连续交付。schema 省略时经来源 /catalog 发现，null 表示不按声明解释。交付内每条完整顶层 TLV 解释为一条记录并登记字段、扩展与字节位置；交付状态为 ok/unclosed/length/corrupt 之一，损坏交付登记字节区间依据并保留已完整记录，原件完整保存。
- GET /deliveries、GET /deliveries/{id}：持久交付目录与单件交付；同 source URL、同摘要、同 schema 重领返回原 id。

GET 请求保持只读；后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。交付记录中 status 非 ok 时 failure 给出 kind、offset 与受影响字节区间 [start,end)，未闭合与长度损坏不继续猜下一条记录。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，流式 BER 接收与 schema 解释在 test/ber.test.mjs，连续交付接口在 test/delivery.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t ber-records:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
