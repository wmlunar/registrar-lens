from flask import Flask, render_template, request, jsonify, make_response, send_file
import pandas as pd
import tldextract
import re
import requests
from urllib.parse import urlparse, quote
import io
from datetime import datetime

app = Flask(__name__)

# 全局变量存储注册商数据
registrars_data = None

def load_registrars_data():
    """加载注册商数据"""
    global registrars_data
    try:
        registrars_data = pd.read_csv('registrar_ids.csv')
        # 清理数据，移除引号
        registrars_data['ID'] = registrars_data['ID'].astype(str)
        registrars_data['Registrar Name'] = registrars_data['Registrar Name'].str.strip('"')
        print(f"已加载 {len(registrars_data)} 条注册商数据")
        return True
    except Exception as e:
        print(f"加载数据失败: {e}")
        return False

def extract_domain_from_input(input_text):
    """从输入中提取二级域名"""
    input_text = input_text.strip()
    
    # 如果输入是URL格式，先解析URL
    if input_text.startswith(('http://', 'https://')):
        parsed = urlparse(input_text)
        domain = parsed.netloc
    else:
        domain = input_text
    
    # 移除www前缀
    if domain.startswith('www.'):
        domain = domain[4:]
    
    # 使用tldextract提取域名各部分
    extracted = tldextract.extract(domain)
    
    # 返回二级域名（domain + suffix，如example.com）
    if extracted.domain and extracted.suffix:
        return f"{extracted.domain}.{extracted.suffix}"
    elif extracted.domain:
        return extracted.domain
    else:
        return None

def query_whois_registrar(domain):
    """通过WHOIS查询域名的注册商"""
    try:
        # 这里可以集成WHOIS查询API
        # 暂时返回示例数据
        return None
    except Exception as e:
        print(f"WHOIS查询失败: {e}")
        return None

def search_registrar_by_domain(domain_to_match):
    """根据二级域名在RDAP Base URL列中搜索注册商"""
    if registrars_data is None:
        return []
    
    results = []
    
    # 在RDAP Base URL列中搜索匹配的内容
    # 首先过滤掉空值和NaN值
    valid_rdap_data = registrars_data[registrars_data['RDAP Base URL'].notna() & 
                                     (registrars_data['RDAP Base URL'] != '')]
    
    # 在RDAP URL中查找包含二级域名的记录
    rdap_matches = valid_rdap_data[
        valid_rdap_data['RDAP Base URL'].str.contains(domain_to_match, case=False, na=False)
    ]
    
    # 处理RDAP URL匹配结果
    for _, row in rdap_matches.iterrows():
        result = {
            'iana_id': row['ID'],
            'registrar_name': row['Registrar Name'],
            'status': row['Status'],
            'rdap_url': row['RDAP Base URL'] if pd.notna(row['RDAP Base URL']) else '',
            'match_type': 'rdap_url'
        }
        results.append(result)
    
    return results

@app.route('/')
def index():
    """主页"""
    return render_template('index.html')

@app.route('/search', methods=['POST'])
def search():
    """单个域名搜索"""
    try:
        domain_input = request.json.get('domain', '').strip()
        if not domain_input:
            return jsonify({'error': '请输入域名'}), 400
        
        # 提取域名核心
        domain_core = extract_domain_from_input(domain_input)
        if not domain_core:
            return jsonify({'error': '无法解析域名'}), 400
        
        # 搜索注册商
        results = search_registrar_by_domain(domain_core)
        
        return jsonify({
            'domain_input': domain_input,
            'domain_core': domain_core,
            'results': results,
            'total': len(results)
        })
        
    except Exception as e:
        return jsonify({'error': f'查询失败: {str(e)}'}), 500

@app.route('/batch_search', methods=['POST'])
def batch_search():
    """批量域名搜索"""
    try:
        domains_input = request.json.get('domains', [])
        if not domains_input:
            return jsonify({'error': '请输入域名列表'}), 400
        
        # 如果输入是字符串，按行分割
        if isinstance(domains_input, str):
            domains_input = [d.strip() for d in domains_input.split('\n') if d.strip()]
        
        batch_results = []
        
        for domain_input in domains_input:
            domain_core = extract_domain_from_input(domain_input)
            if domain_core:
                results = search_registrar_by_domain(domain_core)
                batch_results.append({
                    'domain_input': domain_input,
                    'domain_core': domain_core,
                    'results': results,
                    'total': len(results)
                })
            else:
                batch_results.append({
                    'domain_input': domain_input,
                    'domain_core': None,
                    'results': [],
                    'total': 0,
                    'error': '无法解析域名'
                })
        
        return jsonify({
            'batch_results': batch_results,
            'processed_count': len(batch_results)
        })
        
    except Exception as e:
        return jsonify({'error': f'批量查询失败: {str(e)}'}), 500

@app.route('/api/registrars')
def get_all_registrars():
    """获取所有注册商列表"""
    try:
        if registrars_data is None:
            return jsonify({'error': '数据未加载'}), 500
        
        results = []
        for _, row in registrars_data.iterrows():
            result = {
                'iana_id': row['ID'],
                'registrar_name': row['Registrar Name'],
                'status': row['Status'],
                'rdap_url': row['RDAP Base URL'] if pd.notna(row['RDAP Base URL']) else ''
            }
            results.append(result)
        
        return jsonify({
            'registrars': results,
            'total': len(results)
        })
        
    except Exception as e:
        return jsonify({'error': f'获取数据失败: {str(e)}'}), 500

@app.route('/export', methods=['POST'])
def export_results():
    """导出查询结果为CSV或Excel"""
    try:
        export_data = request.json.get('export_data', [])
        export_format = request.json.get('format', 'csv')  # csv 或 excel
        query_info = request.json.get('query_info', {})
        
        if not export_data:
            return jsonify({'error': '没有数据可导出'}), 400
        
        # 准备导出数据
        export_list = []
        for item in export_data:
            export_list.append({
                'IANA ID': item.get('iana_id', ''),
                '注册商名称': item.get('registrar_name', ''),
                '状态': item.get('status', ''),
                'RDAP URL': item.get('rdap_url', ''),
                '匹配类型': 'RDAP URL匹配' if item.get('match_type') == 'rdap_url' else '名称匹配'
            })
        
        # 创建DataFrame
        df = pd.DataFrame(export_list)
        
        # 生成文件名
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        # 清理域名用于文件名（移除特殊字符）
        safe_domain = re.sub(r'[^\w\-_.]', '_', query_info.get('domain_core', 'query'))
        
        if export_format == 'excel':
            filename = f'IANA_Query_Result_{safe_domain}_{timestamp}.xlsx'
            
            # 创建Excel文件在内存中
            output = io.BytesIO()
            with pd.ExcelWriter(output, engine='openpyxl') as writer:
                df.to_excel(writer, index=False, sheet_name='查询结果')
                
                # 添加查询信息工作表
                query_df = pd.DataFrame([
                    ['查询域名', query_info.get('domain_input', '')],
                    ['提取的二级域名', query_info.get('domain_core', '')],
                    ['查询时间', datetime.now().strftime('%Y-%m-%d %H:%M:%S')],
                    ['结果数量', len(export_list)]
                ], columns=['项目', '值'])
                query_df.to_excel(writer, index=False, sheet_name='查询信息')
            
            output.seek(0)
            
            response = make_response(output.getvalue())
            response.headers['Content-Type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            response.headers['Content-Disposition'] = f'attachment; filename*=UTF-8\'\'{filename}'
            
            return response
            
        else:  # CSV format
            filename = f'IANA_Query_Result_{safe_domain}_{timestamp}.csv'
            
            # 创建CSV文件在内存中
            output = io.StringIO()
            
            # 添加查询信息
            output.write(f"# IANA ID查询结果\n")
            output.write(f"# 查询域名: {query_info.get('domain_input', '')}\n")
            output.write(f"# 提取的二级域名: {query_info.get('domain_core', '')}\n")
            output.write(f"# 查询时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            output.write(f"# 结果数量: {len(export_list)}\n")
            output.write("\n")
            
            # 添加数据
            df.to_csv(output, index=False, encoding='utf-8-sig')
            
            response = make_response(output.getvalue())
            response.headers['Content-Type'] = 'text/csv; charset=utf-8'
            response.headers['Content-Disposition'] = f'attachment; filename*=UTF-8\'\'{filename}'
            
            return response
            
    except Exception as e:
        return jsonify({'error': f'导出失败: {str(e)}'}), 500

@app.route('/batch_export', methods=['POST'])
def batch_export_results():
    """批量导出查询结果"""
    try:
        batch_data = request.json.get('batch_data', [])
        export_format = request.json.get('format', 'csv')
        
        if not batch_data:
            return jsonify({'error': '没有数据可导出'}), 400
        
        # 准备导出数据
        export_list = []
        for batch_item in batch_data:
            domain_input = batch_item.get('domain_input', '')
            domain_core = batch_item.get('domain_core', '')
            results = batch_item.get('results', [])
            
            if results:
                for result in results:
                    export_list.append({
                        '输入域名': domain_input,
                        '提取的二级域名': domain_core,
                        'IANA ID': result.get('iana_id', ''),
                        '注册商名称': result.get('registrar_name', ''),
                        '状态': result.get('status', ''),
                        'RDAP URL': result.get('rdap_url', ''),
                        '匹配类型': 'RDAP URL匹配' if result.get('match_type') == 'rdap_url' else '名称匹配'
                    })
            else:
                export_list.append({
                    '输入域名': domain_input,
                    '提取的二级域名': domain_core,
                    'IANA ID': '',
                    '注册商名称': '未找到匹配结果',
                    '状态': '',
                    'RDAP URL': '',
                    '匹配类型': ''
                })
        
        # 创建DataFrame
        df = pd.DataFrame(export_list)
        
        # 生成文件名
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        if export_format == 'excel':
            filename = f'IANA_Batch_Query_Result_{timestamp}.xlsx'
            
            output = io.BytesIO()
            with pd.ExcelWriter(output, engine='openpyxl') as writer:
                df.to_excel(writer, index=False, sheet_name='批量查询结果')
                
                # 添加统计信息
                stats_df = pd.DataFrame([
                    ['查询时间', datetime.now().strftime('%Y-%m-%d %H:%M:%S')],
                    ['查询域名数量', len(batch_data)],
                    ['总结果数量', len(export_list)],
                    ['有结果的域名数量', len([item for item in batch_data if item.get('results')])]
                ], columns=['项目', '值'])
                stats_df.to_excel(writer, index=False, sheet_name='统计信息')
            
            output.seek(0)
            
            response = make_response(output.getvalue())
            response.headers['Content-Type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            response.headers['Content-Disposition'] = f'attachment; filename*=UTF-8\'\'{filename}'
            
            return response
            
        else:  # CSV format
            filename = f'IANA_Batch_Query_Result_{timestamp}.csv'
            
            output = io.StringIO()
            
            # 添加统计信息
            output.write(f"# IANA ID批量查询结果\n")
            output.write(f"# 查询时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            output.write(f"# 查询域名数量: {len(batch_data)}\n")
            output.write(f"# 总结果数量: {len(export_list)}\n")
            output.write(f"# 有结果的域名数量: {len([item for item in batch_data if item.get('results')])}\n")
            output.write("\n")
            
            df.to_csv(output, index=False, encoding='utf-8-sig')
            
            response = make_response(output.getvalue())
            response.headers['Content-Type'] = 'text/csv; charset=utf-8'
            response.headers['Content-Disposition'] = f'attachment; filename*=UTF-8\'\'{filename}'
            
            return response
            
    except Exception as e:
        return jsonify({'error': f'批量导出失败: {str(e)}'}), 500

if __name__ == '__main__':
    print("正在启动IANA ID查询系统...")
    
    # 加载数据
    if load_registrars_data():
        print("数据加载成功，启动Web服务器...")
        app.run(debug=True, host='0.0.0.0', port=5000)
    else:
        print("数据加载失败，请检查registrar_ids.csv文件")
