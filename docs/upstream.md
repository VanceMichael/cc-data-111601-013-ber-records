# 来源约定

## 产品交换范围

来源使用 BER TLV 子集，class、constructed、tag 三者参与身份；支持 high-tag-number、short/long definite length 以及仅用于 constructed 的 indefinite length。EOC 为当前不定长容器结束，不是普通字节搜索标记；primitive payload 里的 0000 是内容。/schema 只登记已知字段，不要求实现 ASN.1 编译器。未知字段以原 TLV、嵌套路径及字节位置保存，未知构造内容按 BER 结构检查但不按已知 tag 误解释。一个顶层 TLV 是一条记录，能证明边界时可隔离该条的语义失败；长度损坏或顶层未闭合不能继续猜下条，保留未完成/错误的字节依据。

## 当前来源路由

- `/primary`：application/octet-stream
- `/stream`：application/octet-stream
- `/damaged`：application/octet-stream
- `/schema`：application/json

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.itu.int/rec/T-REC-X.690

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
