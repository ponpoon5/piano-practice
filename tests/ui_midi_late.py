import time, sys
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.edge.options import Options
o=Options(); o.add_argument("--headless=new"); o.add_argument("--window-size=1180,820")
d=webdriver.Edge(options=o)
# forEach だけの一覧・あとから接続・状態変化の知らせなし、を再現
d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument",{"source":r"""
window.__plugged=false;
const input={name:'Digital Piano',onmidimessage:null};
const mk=()=>({forEach:(f)=>{ if(window.__plugged) f(input,'i'); }});
navigator.requestMIDIAccess=async()=>({inputs:mk(),outputs:mk()});
window.__press=(p)=>input.onmidimessage&&input.onmidimessage({data:[0x90,p,80]});
"""})
d.get(sys.argv[1]); time.sleep(1.5)
b=lambda: d.find_element(By.CSS_SELECTOR,"#home .midibadge").text
print("接続前:", b())
d.execute_script("window.__plugged=true"); time.sleep(5)
print("接続後:", b())
d.execute_script("window.__press(60)"); time.sleep(0.2)
print("押した:", b())
print("errors:", [l for l in d.get_log("browser") if l["level"]=="SEVERE"])
d.quit()
