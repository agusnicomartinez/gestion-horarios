function App() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '0 auto' }}>
      <h1>Gestión de Horarios</h1>
      <p>
        Proyecto inicializado. La aplicación (login con DNI, panel del supervisor,
        panel del empleado, generación de cronograma) se implementa en la próxima iteración.
      </p>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        v0: los datos viven en <code>localStorage</code>. No requiere setup adicional.
      </p>
    </main>
  )
}

export default App
