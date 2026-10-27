package com.geckocalculator.app;
import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
public class MainActivity extends Activity {
 @Override public void onCreate(Bundle b) { super.onCreate(b); TextView t=new TextView(this); t.setText("Gecko Calculator"); t.setTextSize(28); setContentView(t); }
}
