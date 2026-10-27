package com.geckocalculator.app;
import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.MobileAds;
public class MainActivity extends Activity {
 @Override public void onCreate(Bundle b) {
  super.onCreate(b); MobileAds.initialize(this, status -> {});
  LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(8,17,22)); root.setPadding(16,16,16,8);
  TextView title = new TextView(this); title.setText("🦎 Gecko Calculator"); title.setTextSize(26); title.setTextColor(Color.rgb(57,231,95)); root.addView(title);
  TextView info = new TextView(this); info.setText("Basic calculator project\n\nUse the green buttons to calculate in the full app version."); info.setTextSize(18); info.setTextColor(Color.WHITE); root.addView(info,new LinearLayout.LayoutParams(-1,0,1));
  AdView ad = new AdView(this); ad.setAdSize(AdSize.BANNER); ad.setAdUnitId("ca-app-pub-9371973914123866/8812481769"); root.addView(ad); ad.loadAd(new AdRequest.Builder().build());
  setContentView(root);
 }
}
