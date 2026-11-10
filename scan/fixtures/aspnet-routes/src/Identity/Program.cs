var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Шаблон с {area} первым: не используется, берётся первый без area.
app.MapControllerRoute(
    name: "areas",
    pattern: "{area:exists}/{controller}/{action}");
app.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");

app.Run();
