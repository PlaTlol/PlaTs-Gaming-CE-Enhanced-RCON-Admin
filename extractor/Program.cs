using System;
using System.Linq;
using System.Collections.Generic;
using System.Text.Json;
using UAssetAPI;
using UAssetAPI.UnrealTypes;
using UAssetAPI.ExportTypes;
using UAssetAPI.PropertyTypes.Objects;

class P {
  static void Main(string[] a) {
    string path = @"C:\Program Files\Epic Games\CEUE5Devkit\UE4\Content\Items\ItemTable.uasset";
    string outPath = a.Length>0 ? a[0] : "extracted_items.json";
    var asset = new UAsset(path, EngineVersion.VER_UE5_8);
    var dt = asset.Exports.OfType<DataTableExport>().First(d=>d.Table!=null);
    var map = new Dictionary<string, object>();
    int withName=0, withIcon=0;
    foreach (var row in dt.Table.Data) {
      string id = row.Name.ToString();
      string name=null, icon=null, cat=null; int? stack=null;
      foreach (var pd in row.Value) {
        var fn = pd.Name.ToString();
        if (fn=="Name" && pd is TextPropertyData tp) name = tp.CultureInvariantString?.Value;
        else if (fn=="Icon" && pd is SoftObjectPropertyData sp) {
          try { var an = sp.Value.AssetPath.AssetName.Value?.ToString(); if(!string.IsNullOrEmpty(an)) icon = an; } catch {}
        }
        else if (fn=="GUICategory") { var s = pd.ToString(); if(!string.IsNullOrEmpty(s)) cat = s; }
        else if (fn=="MaxStackSize" && pd is IntPropertyData ip) stack = ip.Value;
      }
      if (string.IsNullOrWhiteSpace(name)) continue;
      withName++;
      var e = new Dictionary<string,object>();
      e["n"] = name;
      if (cat!=null) e["c"] = cat;
      if (icon!=null && !icon.Contains("DEV_needs_icon")) { e["i"] = icon.EndsWith(".png")?icon:icon+".png"; withIcon++; }
      if (stack.HasValue) e["s"] = stack.Value;
      map[id] = e;
    }
    System.IO.File.WriteAllText(outPath, JsonSerializer.Serialize(map));
    Console.WriteLine($"EXTRACTED rows={dt.Table.Data.Count} named={withName} withIcon={withIcon} -> {outPath}");
    foreach (var id in new[]{"1","900","901","920","50000","96037","96281"}) {
      Console.WriteLine($"  check {id}: " + (map.ContainsKey(id) ? JsonSerializer.Serialize(map[id]) : "(absent)"));
    }
  }
}
