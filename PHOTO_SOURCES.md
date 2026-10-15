# 餐品照片来源

这八张 PNG 为麦当劳中国官方产品页展示的产品照片，下载于 2026-10-15，保留官方原始字节，未经生成、重绘、裁切或压缩。图片著作权及相关品牌权利归原权利人所有；本项目不主张这些图片的权利，项目代码的许可不适用于这些第三方图片。

照片仅作对应产品的视觉示意。不同杯型或份量可能共用同一官方产品照片，不能据图片推断精确份量；实际所选规格、组成与营养以界面文字及对应官方数据为准。参考菜单照片不证明门店当前有售，也不替代实时套餐组成。

官方图片域名对无来源请求返回 403，本地文件通过对应官方产品页作为 Referer 的普通图片请求取得，避免用户浏览器因防盗链加载失败。实时门店菜单仍使用官方 MCP 返回的对应餐品图片。

| 本地文件 | 对应参考餐品 ID | 官方产品页 | 官方原图 | 字节数 | 像素 | SHA-256 |
| --- | --- | --- | --- | ---: | --- | --- |
| `dist/assets/food/grilled-chicken.png` | `grilled-chicken` | [板烧鸡腿堡](https://www.mcdonalds.com.cn/product/Grilled-Chicken-Sandwich) | [原图](https://officiaweb-afd.mcdonalds.com.cn/public/upload/attachment/2024/10/202410121642022710.png) | 376547 | 640 × 640 | `a663bd065795e1c2ad6b906d9196c4fa6b42e965613bbbb46eaafd8b9aca2ad6` |
| `dist/assets/food/cheeseburger.png` | `cheeseburger` | [吉士汉堡包](https://www.mcdonalds.com.cn/product/Cheeseburger) | [原图](https://officiaweb-afd.mcdonalds.com.cn/public/upload/attachment/2022/08/202208081013284833.png) | 277168 | 640 × 640 | `6ef69e30f76d6ea66985e5b812bc5061de4a47695b16656cf3f73244a9716788` |
| `dist/assets/food/fries.png` | `fries-small`, `fries-medium`, `fries-large` | [薯条](https://www.mcdonalds.com.cn/product/french-fries) | [原图](https://officiaweb-afd.mcdonalds.com.cn/public/upload/attachment/2022/08/202208091547349086.png) | 170634 | 640 × 640 | `1f39c69c9e0974bdc49d5e2e0030ffb70dffefc1b5330db41a6ad658966a545b` |
| `dist/assets/food/corn.png` | `corn-small`, `corn-large` | [玉米杯](https://www.mcdonalds.com.cn/product/Corn-Cup) | [原图](https://officiaweb-afd.mcdonalds.com.cn/public/upload/attachment/2022/08/202208091548118821.png) | 158235 | 640 × 640 | `b37797baadb11abbef7244ef1de9d9e33f81bc425413457e6a7094589b144520` |
| `dist/assets/food/cola.png` | `cola-medium`, `cola-large` | [可口可乐](https://www.mcdonalds.com.cn/product/Coca-Cola) | [原图](https://officiaweb-afd.mcdonalds.com.cn/public/upload/attachment/2022/08/202208091541242793.png) | 217483 | 640 × 640 | `aef0773e3a64fc6c5763f4e66a3d0d389e34e859d0c08018dee95ccc133ccb25` |
| `dist/assets/food/cola-zero.png` | `cola-zero-medium` | [无糖可口可乐](https://www.mcdonalds.com.cn/product/coca-cola-zero) | [原图](https://officiaweb-afd.mcdonalds.com.cn/public/upload/attachment/2022/08/202208091542266222.png) | 259417 | 640 × 640 | `9b2d2df67f1dcdd35f123d3bf062b791f209760485e3671929b9c0bca2f36449` |
| `dist/assets/food/nuggets-five.png` | `nuggets-five` | [麦乐鸡（5块）](https://www.mcdonalds.com.cn/product/chicken-mcnuggets) | [原图](https://officiaweb-afd.mcdonalds.com.cn/public/upload/attachment/2022/08/202208091547543048.png) | 217130 | 640 × 640 | `aa8fd372de511b6856c039f79246d57e1fb612bca668813f763352b25157d853` |
| `dist/assets/food/cone.png` | `cone` | [圆筒冰淇淋](https://www.mcdonalds.com.cn/product/Cone) | [原图](https://officiaweb-afd.mcdonalds.com.cn/public/upload/attachment/2020/05/202005270949182813.png) | 224008 | 640 × 640 | `9b6bb67aab50c3fdad77bbe177e9669c5d04b8b71b2d4d0f07359cbdeb6c23d3` |

`dist/product-photos.mjs` 提供 `referencePhotos` 映射：餐品 ID → `{ src, sourceUrl }`。`sourceUrl` 指向可核对产品身份的官方产品页；`src` 指向随站点发布的原始 PNG。
