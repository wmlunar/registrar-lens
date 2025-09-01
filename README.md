# IANA ID 查询系统

一个基于Flask的IANA注册商ID查询网站，支持通过域名查询相关的注册商信息。

## 功能特性

- 🔍 **单个域名查询**：支持多种格式的域名输入
- 📋 **批量查询**：一次性查询多个域名
- 🌐 **智能域名解析**：自动从URL中提取域名核心部分
- 📊 **详细信息展示**：显示注册商ID、名称、状态和RDAP URL
- 📱 **响应式设计**：支持桌面和移动设备

## 支持的输入格式

系统可以智能解析以下格式的域名输入：

- `nawang.cn`
- `www.nawang.cn`
- `https://www.zzy.cn/domain/`
- `http://example.com/path`

系统会自动提取域名的核心部分（如：nawang、zzy、example）进行查询。

## 安装和运行

### 环境要求

- Python 3.7+
- pip

### 安装步骤

1. 克隆或下载项目文件
2. 安装依赖包：
   ```bash
   pip install -r requirements.txt
   ```
3. 确保`registrar_ids.csv`文件在项目根目录
4. 运行应用：
   ```bash
   python app.py
   ```
5. 打开浏览器访问：`http://localhost:5000`

## 文件结构

```
flask_naia/
├── app.py                 # Flask应用主文件
├── requirements.txt       # Python依赖包
├── registrar_ids.csv     # IANA注册商数据
├── templates/
│   └── index.html        # 主页模板
└── README.md             # 项目说明
```

## API接口

### 单个域名查询
- **URL**: `/search`
- **方法**: POST
- **参数**: `{"domain": "domain_name"}`
- **返回**: 查询结果JSON

### 批量域名查询
- **URL**: `/batch_search`
- **方法**: POST
- **参数**: `{"domains": ["domain1", "domain2", ...]}`
- **返回**: 批量查询结果JSON

### 获取所有注册商
- **URL**: `/api/registrars`
- **方法**: GET
- **返回**: 所有注册商信息JSON

## 技术栈

- **后端**: Flask (Python)
- **前端**: HTML5, CSS3, JavaScript
- **数据处理**: pandas
- **域名解析**: tldextract
- **样式**: 响应式CSS Grid/Flexbox

## 数据来源

注册商数据来源于IANA（Internet Assigned Numbers Authority）官方数据，包含：
- 注册商ID
- 注册商名称
- 状态（Accredited/Reserved/Terminated）
- RDAP基础URL

## 使用说明

1. **单个查询**：在输入框中输入域名或URL，点击查询按钮
2. **批量查询**：切换到批量查询标签，每行输入一个域名，点击批量查询按钮
3. **查看结果**：系统会显示匹配的注册商信息，包括详细的注册商数据

## 注意事项

- 查询基于注册商名称的模糊匹配
- 系统会自动去除www前缀和URL路径
- 支持国际化域名
- 结果按相关性排序

## 开发和扩展

如需扩展功能，可以考虑：
- 集成WHOIS API进行实时查询
- 添加域名历史信息
- 支持更多查询条件
- 添加导出功能

## 许可证

本项目仅用于学习和研究目的。
